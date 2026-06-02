// SPDX-License-Identifier: GPL-3.0-or-later
package daemon

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"m3uhandler/internal/config"
	"m3uhandler/internal/convert"
	"m3uhandler/internal/logger"
)

// trailingPageRe matches a URL whose path ends with a plain integer, with an
// optional query string. Capture groups: (prefix) (number) (query-or-empty).
var trailingPageRe = regexp.MustCompile(`^(.*/)(\d+)(\?.*)?$`)

// asPaginatedTemplate converts a URL ending in a number (e.g. ".../tvshows/1")
// into a %d template (".../tvshows/%d") using pure string replacement so that
// the Go URL package never gets a chance to percent-encode the % sign.
func asPaginatedTemplate(rawURL string) (string, bool) {
	m := trailingPageRe.FindStringSubmatch(rawURL)
	if m == nil {
		return rawURL, false
	}
	return m[1] + "%d" + m[3], true
}

// errPageNotFound is returned by fetchToFile when the server responds 404.
// Used to stop auto-pagination cleanly.
var errPageNotFound = errors.New("page not found (404)")

const usageText = `m3uHandler daemon - periodically fetch an M3U URL and generate .strm files

Usage:
  m3uhandler daemon --url <m3u_url> [options]

Options:
      --url <url>              Generic playlist URL to fetch
      --url-tv <url|tpl>       TV shows URL; supports %d or trailing number for auto-pagination
      --url-movies <url>       Movies URL (single, no pagination)
      --url-events <url>       Sports VOD / events URL (single, no pagination)
      --use-config             Load URL + settings from config (~/.config/m3uHandler/config.json)
  -o, --out <dir>              Output directory (default: output)
      --include-live           Also write live .strm entries
      --movies-flat            Put movies directly under Movies/ (no year sub-folder)
      --movies-by-folder       Put movies under Movies/<Movie Name>/<Movie Name>.strm
      --movies-by-year-folder  Put movies under Movies/<Year>/<Movie Name>/<Movie Name>.strm
      --no-delete-missing      Do not delete .strm files missing from latest playlist
      --no-overwrite           Skip writing a .strm that already exists on disk
      --skip-if-media-exists   Skip writing a .strm when a local media file (.mkv, .mp4, …) with the same name already exists
      --write-concurrency <n>  Parallel .strm writers (default: 8)
      --interval-hours <n>     Poll interval in hours (default: 24)
      --interval-seconds <n>   Poll interval in seconds (overrides hours)
      --once                   Run one update and exit
  -h, --help                   Show this help
`

type urlEntry struct {
	label       string
	url         string
	defaultType string
}

// redactURL masks credentials and unknown query params so they are safe to log.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<invalid-url>"
	}
	if u.User != nil {
		_, hasPass := u.User.Password()
		if u.User.Username() != "" || hasPass {
			u.User = url.UserPassword("***", "***")
		}
	}
	allow := map[string]bool{"type": true, "profile": true, "quality": true, "format": true}
	q := u.Query()
	for k := range q {
		if !allow[strings.ToLower(k)] {
			q.Set(k, "***")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// sanitizeLog removes raw secret strings from a log message.
func sanitizeLog(msg string, secrets []string) string {
	s := msg
	for _, secret := range secrets {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "***")
		}
	}
	return s
}

// fetchToFile streams rawURL directly into a temp file. Returns the temp file
// path; caller must remove it when done. Returns errPageNotFound on 404.
func fetchToFile(ctx context.Context, rawURL string, timeoutMs int) (string, error) {
	client := &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return "", errPageNotFound
	}
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return "", fmt.Errorf("fetch failed: %d %s\n%s", resp.StatusCode, resp.Status, body)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return "", fmt.Errorf("fetch failed: %d %s\n%s", resp.StatusCode, resp.Status, body)
	}

	tmp, err := os.CreateTemp("", "m3uHandler-*.m3u8")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return tmp.Name(), nil
}

type runOpts struct {
	outRoot            string
	includeLive        bool
	overwrite          bool
	moviesByYear       bool
	moviesByFolder     bool
	moviesByYearFolder bool
	deleteMissing      bool
	skipIfMediaExists  bool
	writeConcurrency   int
	progressEvery      int
	timeoutMs          int
	log                *logger.Logger
}

// convertFile runs ConvertM3U on an already-fetched temp file path.
func convertFile(tmpPath string, label string, opts runOpts, defaultType string) (convert.Stats, error) {
	result, err := convert.ConvertM3U(convert.Options{
		InputPath:          tmpPath,
		OutRoot:            opts.outRoot,
		IncludeLive:        opts.includeLive,
		Overwrite:          opts.overwrite,
		DryRun:             false,
		MoviesByYear:       opts.moviesByYear,
		MoviesByFolder:     opts.moviesByFolder,
		MoviesByYearFolder: opts.moviesByYearFolder,
		DeleteMissing:      opts.deleteMissing,
		SkipIfMediaExists:  opts.skipIfMediaExists,
		WriteConcurrency:   opts.writeConcurrency,
		ProgressEvery:      opts.progressEvery,
		OnProgress: func(written, skipped, done, total int) {
			opts.log.Infof("[%s] %s progress: %d/%d done — written=%d skipped=%d",
				time.Now().UTC().Format(time.RFC3339), label, done, total, written, skipped)
		},
		DefaultType: defaultType,
	})
	if err != nil {
		return convert.Stats{}, err
	}
	return result.Stats, nil
}

// runOnce fetches a URL and converts it.
func runOnce(ctx context.Context, entry urlEntry, opts runOpts) (convert.Stats, error) {
	tmpPath, err := fetchToFile(ctx, entry.url, opts.timeoutMs)
	if err != nil {
		return convert.Stats{}, err
	}
	defer os.Remove(tmpPath)
	return convertFile(tmpPath, entry.label, opts, entry.defaultType)
}

// runPaginated fetches pages 1, 2, 3… of tplURL (which must contain %d) until
// a 404 is returned, converting each page in turn.
func runPaginated(ctx context.Context, tplURL string, defaultType string, opts runOpts, secrets []string, isLast bool) (convert.Stats, error) {
	var total convert.Stats
	for page := 1; ; page++ {
		u := fmt.Sprintf(tplURL, page)
		label := fmt.Sprintf("tv-page%d", page)

		tmpPath, err := fetchToFile(ctx, u, opts.timeoutMs)
		if err != nil {
			if errors.Is(err, errPageNotFound) {
				opts.log.Infof("[%s] %s: 404 — done after %d page(s)",
					time.Now().UTC().Format(time.RFC3339), label, page-1)
			} else {
				opts.log.Error(sanitizeLog(
					fmt.Sprintf("[%s] %s fetch failed: %v", time.Now().UTC().Format(time.RFC3339), label, err),
					secrets,
				))
			}
			break
		}

		pageOpts := opts
		// Only the very last page of the last source triggers delete-missing.
		pageOpts.deleteMissing = false

		stats, err := convertFile(tmpPath, label, pageOpts, defaultType)
		os.Remove(tmpPath)
		if err != nil {
			opts.log.Errorf("[%s] %s convert failed: %v", time.Now().UTC().Format(time.RFC3339), label, err)
		} else {
			opts.log.Infof("[%s] %s done. written=%d skipped=%d ignored=%d deleted=%d",
				time.Now().UTC().Format(time.RFC3339), label,
				stats.Written, stats.Skipped, stats.Ignored, stats.Deleted)
			total.Written += stats.Written
			total.Skipped += stats.Skipped
			total.Ignored += stats.Ignored
			total.Deleted += stats.Deleted
		}

		if ctx.Err() != nil {
			break
		}
	}
	return total, nil
}

// Run is the entry point for the daemon subcommand.
func Run(args []string) {
	fs := flag.NewFlagSet("daemon", flag.ExitOnError)
	fs.Usage = func() { os.Stdout.WriteString(usageText) }

	var (
		rawURL             = fs.String("url", "", "")
		rawURLTv           = fs.String("url-tv", "", "")
		rawURLMovies       = fs.String("url-movies", "", "")
		rawURLEvents       = fs.String("url-events", "", "")
		useConfig          = fs.Bool("use-config", false, "")
		out                = fs.String("out", "output", "")
		includeLive        = fs.Bool("include-live", false, "")
		moviesFlat         = fs.Bool("movies-flat", false, "")
		moviesByFolder     = fs.Bool("movies-by-folder", false, "")
		moviesByYearFolder = fs.Bool("movies-by-year-folder", false, "")
		noDeleteMissing    = fs.Bool("no-delete-missing", false, "")
		noOverwrite        = fs.Bool("no-overwrite", false, "")
		skipIfMediaExists  = fs.Bool("skip-if-media-exists", false, "")
		writeConcurrency   = fs.Int("write-concurrency", 8, "")
		intervalHours      = fs.Float64("interval-hours", 24, "")
		intervalSeconds    = fs.Int("interval-seconds", 0, "")
		once               = fs.Bool("once", false, "")
		progressEvery      = fs.Int("progress-every", 1000, "")
		help               = fs.Bool("help", false, "")
	)
	fs.StringVar(out, "o", "output", "")

	_ = fs.Parse(args)

	if *help {
		os.Stdout.WriteString(usageText)
		return
	}

	log := logger.New("")

	// Load config if requested
	var cfg *config.Config
	if *useConfig {
		var err error
		cfg, err = config.Load()
		if err != nil {
			p, _ := config.ConfigPath()
			log.Errorf("No config found at %s: %v", p, err)
			os.Exit(1)
		}
	}

	// Resolve effective values (flags take precedence over config)
	finalURL := *rawURL
	if cfg != nil && cfg.URL != "" && finalURL == "" {
		finalURL = cfg.URL
	}
	finalURLTv := *rawURLTv
	if cfg != nil && cfg.URLTv != "" && finalURLTv == "" {
		finalURLTv = cfg.URLTv
	}
	finalURLMovies := *rawURLMovies
	if cfg != nil && cfg.URLMovies != "" && finalURLMovies == "" {
		finalURLMovies = cfg.URLMovies
	}
	finalURLEvents := *rawURLEvents
	if cfg != nil && cfg.URLEvents != "" && finalURLEvents == "" {
		finalURLEvents = cfg.URLEvents
	}

	if finalURL == "" && finalURLTv == "" && finalURLMovies == "" && finalURLEvents == "" {
		os.Stderr.WriteString(usageText)
		os.Exit(1)
	}

	outRoot, _ := filepath.Abs(func() string {
		if cfg != nil && cfg.Out != "" {
			return cfg.Out
		}
		return *out
	}())

	inclLive := *includeLive
	if cfg != nil {
		inclLive = cfg.IncludeLive
	}

	moviesByYear := !*moviesFlat
	if cfg != nil && cfg.MoviesFlat {
		moviesByYear = false
	}
	mByFolder := *moviesByFolder
	if cfg != nil && cfg.MoviesByFolder {
		mByFolder = true
	}
	mByYearFolder := *moviesByYearFolder
	if cfg != nil && cfg.MoviesByYearFolder {
		mByYearFolder = true
	}

	intervalSec := int(*intervalHours * 3600)
	if *intervalSeconds > 0 {
		intervalSec = *intervalSeconds
	}
	if cfg != nil && cfg.IntervalHours > 0 {
		intervalSec = int(cfg.IntervalHours * 3600)
	}

	if intervalSec <= 0 {
		log.Error("Interval must be a positive number.")
		os.Exit(1)
	}

	// Fixed single-URL entries (non-paginated).
	var entries []urlEntry
	if finalURL != "" {
		entries = append(entries, urlEntry{label: "playlist", url: finalURL, defaultType: ""})
	}
	if finalURLMovies != "" {
		entries = append(entries, urlEntry{label: "movies", url: finalURLMovies, defaultType: "movies"})
	}
	if finalURLEvents != "" {
		entries = append(entries, urlEntry{label: "events", url: finalURLEvents, defaultType: "events"})
	}

	// Collect secrets for log sanitisation.
	allURLs := []string{finalURL, finalURLTv, finalURLMovies, finalURLEvents}
	var secrets []string
	for _, raw := range allURLs {
		if u, err := url.Parse(raw); err == nil && u.User != nil {
			if name := u.User.Username(); name != "" {
				secrets = append(secrets, name)
			}
			if pass, ok := u.User.Password(); ok && pass != "" {
				secrets = append(secrets, pass)
			}
		}
	}

	timeoutMs := 300000
	if v := os.Getenv("FETCH_TIMEOUT_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			timeoutMs = n
		}
	}

	rOpts := runOpts{
		outRoot:            outRoot,
		includeLive:        inclLive,
		overwrite:          !*noOverwrite,
		moviesByYear:       moviesByYear,
		moviesByFolder:     mByFolder,
		moviesByYearFolder: mByYearFolder,
		deleteMissing:      !*noDeleteMissing,
		skipIfMediaExists:  *skipIfMediaExists,
		writeConcurrency:   *writeConcurrency,
		progressEvery:      *progressEvery,
		timeoutMs:          timeoutMs,
		log:                log,
	}

	// Build display URLs for startup log.
	var safeURLs []string
	if finalURL != "" {
		safeURLs = append(safeURLs, "playlist="+redactURL(finalURL))
	}
	if finalURLTv != "" {
		safeURLs = append(safeURLs, "tv="+redactURL(finalURLTv))
	}
	if finalURLMovies != "" {
		safeURLs = append(safeURLs, "movies="+redactURL(finalURLMovies))
	}
	if finalURLEvents != "" {
		safeURLs = append(safeURLs, "events="+redactURL(finalURLEvents))
	}

	log.Infof("m3uHandler daemon started\nURL: %s\nOutput: %s\nInterval: %ds\nDelete missing: %v\nLog: %s",
		strings.Join(safeURLs, " "), outRoot, intervalSec, !*noDeleteMissing, log.LogPath)

	// Signal handling.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	signalCount := 0
	go func() {
		for sig := range sigCh {
			signalCount++
			if signalCount >= 2 {
				log.Warnf("received %s (%d) - forcing exit", sig, signalCount)
				os.Exit(1)
			}
			log.Warnf("received %s (%d) - will stop after current cycle", sig, signalCount)
			cancel()
		}
	}()

	for {
		started := time.Now().UTC()
		log.Infof("[%s] updating...", started.Format(time.RFC3339))

		// TV: paginate through all pages until 404 (if --url-tv contains or ends with a page number).
		if finalURLTv != "" {
			if tpl, ok := asPaginatedTemplate(finalURLTv); ok && !strings.Contains(finalURLTv, "%d") {
				finalURLTv = tpl
			}
			isPaginated := strings.Contains(finalURLTv, "%d")
			isLastSource := len(entries) == 0
			if isPaginated {
				stats, _ := runPaginated(ctx, finalURLTv, "tvshows", rOpts, secrets, isLastSource)
				log.Infof("[%s] tv total. written=%d skipped=%d ignored=%d deleted=%d",
					time.Now().UTC().Format(time.RFC3339),
					stats.Written, stats.Skipped, stats.Ignored, stats.Deleted)
			} else {
				opts := rOpts
				opts.deleteMissing = rOpts.deleteMissing && isLastSource
				stats, err := runOnce(ctx, urlEntry{label: "tv", url: finalURLTv, defaultType: "tvshows"}, opts)
				if err != nil {
					log.Error(sanitizeLog(fmt.Sprintf("[%s] tv failed: %v", time.Now().UTC().Format(time.RFC3339), err), secrets))
				} else {
					log.Infof("[%s] tv done. written=%d skipped=%d ignored=%d deleted=%d",
						time.Now().UTC().Format(time.RFC3339),
						stats.Written, stats.Skipped, stats.Ignored, stats.Deleted)
				}
			}
		}

		// Fixed entries (generic playlist + movies).
		for i, entry := range entries {
			isLast := i == len(entries)-1
			opts := rOpts
			opts.deleteMissing = rOpts.deleteMissing && isLast

			stats, err := runOnce(ctx, entry, opts)
			if err != nil {
				log.Error(sanitizeLog(
					fmt.Sprintf("[%s] %s failed: %v", time.Now().UTC().Format(time.RFC3339), entry.label, err),
					secrets,
				))
			} else {
				log.Infof("[%s] %s done. written=%d skipped=%d ignored=%d deleted=%d",
					time.Now().UTC().Format(time.RFC3339), entry.label,
					stats.Written, stats.Skipped, stats.Ignored, stats.Deleted)
			}
		}

		if *once || ctx.Err() != nil {
			break
		}

		// Sleep in 1-second chunks to honour cancellation quickly.
		remaining := time.Duration(intervalSec) * time.Second
		for remaining > 0 && ctx.Err() == nil {
			chunk := time.Second
			if chunk > remaining {
				chunk = remaining
			}
			select {
			case <-time.After(chunk):
				remaining -= chunk
			case <-ctx.Done():
				remaining = 0
			}
		}

		if ctx.Err() != nil {
			break
		}
	}
}
