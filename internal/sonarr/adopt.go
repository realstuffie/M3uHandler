// SPDX-License-Identifier: GPL-3.0-or-later
package sonarr

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"

	"m3uhandler/internal/arr"
	"m3uhandler/internal/logger"
)

const adoptUsage = `sonarr-adopt - Bulk-import an existing TV library into Sonarr

Usage:
  SONARR_URL="http://127.0.0.1:8989" SONARR_API_KEY="..." \
    m3uhandler sonarr-adopt --location "/mnt/tv"

Required:
  --location <path>                Library root. Used as scan path AND Sonarr rootFolderPath.
                                   Folders must be named "Title (Year)" or "Title".

Optional:
  --library-path <path>            Override scan location (advanced)
  --root-folder <path>             Override Sonarr rootFolderPath (advanced)
  --monitored <true|false>         Default true
  --search                         Tell Sonarr to search for missing episodes after add
  --season-folder <true|false>     Default true
  --series-type <type>             standard | daily | anime  (default: standard)
  --quality-profile <n>            Quality profile ID (default: 1)
  --language-profile <n>           Language profile ID (default: 1)
  --dry-run                        Scan and prepare only; do not call Sonarr
  --lookup-concurrency <n>         Parallel lookup calls (default 10)
  --add-concurrency <n>            Parallel add calls (default 2)
  --state <path>                   Resume state file (default output/sonarr-adopt-state.json)
  --cache <path>                   Lookup cache file (default output/sonarr-lookup-cache.json)
  -h, --help                       Show this help
`

// ---- models ----------------------------------------------------------------

type sonarrSeries struct {
	TvdbID int    `json:"tvdbId"`
	Path   string `json:"path"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
}

type lookupResult struct {
	TvdbID int    `json:"tvdbId"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
}

type cacheEntry struct {
	TvdbID int    `json:"tvdbId"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
}

type adoptState struct {
	AddedPaths map[string]bool `json:"addedPaths"`
}

// ---- library scan ----------------------------------------------------------

var titleYearRe = regexp.MustCompile(`^(.*)\s+\((\d{4})\)\s*$`)

type candidate struct {
	title string
	year  int // 0 when no year in folder name
	path  string
}

func scanLibrary(libraryPath string) ([]candidate, error) {
	entries, err := os.ReadDir(libraryPath)
	if err != nil {
		return nil, err
	}
	var out []candidate
	for _, ent := range entries {
		if !ent.IsDir() {
			continue
		}
		if m := titleYearRe.FindStringSubmatch(ent.Name()); m != nil {
			year, _ := strconv.Atoi(m[2])
			out = append(out, candidate{title: m[1], year: year, path: filepath.Join(libraryPath, ent.Name())})
		} else if title := ent.Name(); title != "" {
			// No year — e.g. "Firefly"
			out = append(out, candidate{title: title, path: filepath.Join(libraryPath, ent.Name())})
		}
	}
	return out, nil
}

func cacheKey(c candidate) string {
	if c.year != 0 {
		return fmt.Sprintf("%s (%d)", c.title, c.year)
	}
	return c.title
}

// ---- error helpers ---------------------------------------------------------

func isAlreadyExistsErr(err error) bool {
	var ae *arr.APIError
	if !errors.As(err, &ae) || ae.Status != 400 {
		return false
	}
	var errs []struct {
		ErrorCode string `json:"errorCode"`
	}
	if json.Unmarshal([]byte(ae.Body), &errs) != nil {
		return false
	}
	for _, e := range errs {
		if e.ErrorCode == "SeriesExistsValidator" {
			return true
		}
	}
	return false
}

// ---- adopt -----------------------------------------------------------------

// AdoptOptions controls the sonarr-adopt run.
type AdoptOptions struct {
	BaseURL             string
	APIKey              string
	LibraryPath         string
	RootFolderPath      string
	Monitored           bool
	SearchForMissingEps bool
	SeasonFolder        bool
	SeriesType          string
	QualityProfileID    int
	LanguageProfileID   int
	DryRun              bool
	LookupConcurrency   int
	AddConcurrency      int
	StatePath           string
	CachePath           string
}

// AdoptLibrary scans libraryPath, looks up series in Sonarr, and adds any
// that are missing. Returns (candidates, prepared, added) counts.
func AdoptLibrary(opts AdoptOptions, log *logger.Logger) (candidates, prepared, added int, err error) {
	absLibrary, _ := filepath.Abs(opts.LibraryPath)

	state := adoptState{AddedPaths: map[string]bool{}}
	arr.ReadJSONFile(opts.StatePath, &state)
	if state.AddedPaths == nil {
		state.AddedPaths = map[string]bool{}
	}

	lookupCache := map[string]*cacheEntry{}
	arr.ReadJSONFile(opts.CachePath, &lookupCache)

	logStage := func(msg string) { log.Infof("\n==> %s", msg) }

	logStage("Configuration")
	log.Infof("Library path: %s", absLibrary)
	log.Infof("Sonarr rootFolderPath: %s", opts.RootFolderPath)
	log.Infof("monitored=%v | searchForMissingEpisodes=%v | seasonFolder=%v | seriesType=%s | dryRun=%v | lookupConcurrency=%d | addConcurrency=%d",
		opts.Monitored, opts.SearchForMissingEps, opts.SeasonFolder, opts.SeriesType,
		opts.DryRun, opts.LookupConcurrency, opts.AddConcurrency)

	client := arr.NewClient(opts.BaseURL, opts.APIKey)

	existingByPath := map[string]sonarrSeries{}
	existingByTvdb := map[int]sonarrSeries{}

	if !opts.DryRun {
		logStage("Loading existing series from Sonarr")
		var existing []sonarrSeries
		if err := client.GetJSON("/api/v3/series", nil, &existing); err != nil {
			return 0, 0, 0, fmt.Errorf("list series: %w", err)
		}
		for _, s := range existing {
			if s.Path != "" {
				existingByPath[s.Path] = s
			}
			if s.TvdbID != 0 {
				existingByTvdb[s.TvdbID] = s
			}
		}
		log.Infof("Loaded %d existing series from Sonarr.", len(existing))
	}

	logStage("Scanning library for \"Title (Year)\" or \"Title\" folders")
	cands, err := scanLibrary(absLibrary)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("scan library: %w", err)
	}

	var filtered []candidate
	for _, c := range cands {
		if state.AddedPaths[c.path] {
			continue
		}
		if _, exists := existingByPath[c.path]; exists {
			continue
		}
		filtered = append(filtered, c)
	}
	log.Infof("Found %d candidate series folders to add.", len(filtered))

	// Determine which cache entries are missing.
	var missingIdx []int
	for i, c := range filtered {
		if _, ok := lookupCache[cacheKey(c)]; !ok && !opts.DryRun {
			missingIdx = append(missingIdx, i)
		}
	}

	logStage(fmt.Sprintf("TVDB lookup via Sonarr (concurrency=%d)", opts.LookupConcurrency))
	var (
		lookupDone int64
		cacheMu    sync.Mutex
	)
	arr.MapConcurrent(len(missingIdx), opts.LookupConcurrency, func(j int) {
		i := missingIdx[j]
		c := filtered[i]
		key := cacheKey(c)
		term := c.title
		if c.year != 0 {
			term = fmt.Sprintf("%s %d", c.title, c.year)
		}

		var results []lookupResult
		_ = arr.WithRetries(func() error {
			return client.GetJSON("/api/v3/series/lookup", map[string]string{"term": term}, &results)
		}, log)

		var entry *cacheEntry
		for _, r := range results {
			if c.year != 0 && r.Year == c.year {
				entry = &cacheEntry{TvdbID: r.TvdbID, Title: r.Title, Year: r.Year}
				break
			}
		}
		if entry == nil && len(results) > 0 {
			r := results[0]
			entry = &cacheEntry{TvdbID: r.TvdbID, Title: r.Title, Year: r.Year}
		}

		cacheMu.Lock()
		lookupCache[key] = entry
		n := atomic.AddInt64(&lookupDone, 1)
		if n%200 == 0 {
			_ = arr.WriteJSONAtomic(opts.CachePath, lookupCache)
			log.Infof("TVDB lookup progress: %d/%d", n, len(missingIdx))
		}
		cacheMu.Unlock()
	})
	log.Infof("TVDB lookup done: %d/%d", len(missingIdx), len(missingIdx))
	_ = arr.WriteJSONAtomic(opts.CachePath, lookupCache)

	// Build payloads.
	monitor := "none"
	if opts.Monitored {
		monitor = "all"
	}

	type addOptions struct {
		SearchForMissingEpisodes bool   `json:"searchForMissingEpisodes"`
		Monitor                  string `json:"monitor"`
	}
	type seriesPayload struct {
		TvdbID            int        `json:"tvdbId"`
		Title             string     `json:"title"`
		Year              int        `json:"year"`
		QualityProfileID  int        `json:"qualityProfileId"`
		LanguageProfileID int        `json:"languageProfileId"`
		RootFolderPath    string     `json:"rootFolderPath"`
		Path              string     `json:"path"`
		Monitored         bool       `json:"monitored"`
		SeasonFolder      bool       `json:"seasonFolder"`
		SeriesType        string     `json:"seriesType"`
		AddOptions        addOptions `json:"addOptions"`
	}

	var toAdd []seriesPayload
	for _, c := range filtered {
		entry := lookupCache[cacheKey(c)]
		if entry == nil || entry.TvdbID == 0 {
			continue
		}
		if !opts.DryRun {
			if _, exists := existingByTvdb[entry.TvdbID]; exists {
				continue
			}
		}
		toAdd = append(toAdd, seriesPayload{
			TvdbID:            entry.TvdbID,
			Title:             entry.Title,
			Year:              entry.Year,
			QualityProfileID:  opts.QualityProfileID,
			LanguageProfileID: opts.LanguageProfileID,
			RootFolderPath:    opts.RootFolderPath,
			Path:              c.path,
			Monitored:         opts.Monitored,
			SeasonFolder:      opts.SeasonFolder,
			SeriesType:        opts.SeriesType,
			AddOptions: addOptions{
				SearchForMissingEpisodes: opts.SearchForMissingEps,
				Monitor:                  monitor,
			},
		})
	}
	log.Infof("Prepared %d series to add.", len(toAdd))

	if opts.DryRun {
		log.Infof("Dry-run: would add %d series (no API calls)", len(toAdd))
		return len(cands), len(toAdd), len(toAdd), nil
	}

	logStage(fmt.Sprintf("Adding series to Sonarr (concurrency=%d)", opts.AddConcurrency))

	var (
		addedCount    int64
		skippedExists int64
		failed        int64
		stateMu       sync.Mutex
		existMu       sync.Mutex
	)

	arr.MapConcurrent(len(toAdd), opts.AddConcurrency, func(i int) {
		series := toAdd[i]
		var result sonarrSeries
		addErr := arr.WithRetries(func() error {
			return client.PostJSON("/api/v3/series", series, &result)
		}, log)

		if addErr != nil {
			if isAlreadyExistsErr(addErr) {
				atomic.AddInt64(&skippedExists, 1)
			} else {
				atomic.AddInt64(&failed, 1)
				log.Errorf("Failed to add %s: %v", series.Path, addErr)
			}
		} else {
			existMu.Lock()
			if result.TvdbID != 0 {
				existingByTvdb[result.TvdbID] = result
			}
			if result.Path != "" {
				existingByPath[result.Path] = result
			}
			existMu.Unlock()
		}

		p := result.Path
		if p == "" {
			p = series.Path
		}
		stateMu.Lock()
		state.AddedPaths[p] = true
		_ = arr.WriteJSONAtomic(opts.StatePath, state)
		stateMu.Unlock()

		n := atomic.AddInt64(&addedCount, 1)
		if n%100 == 0 || int(n) == len(toAdd) {
			log.Infof("Add progress: %d/%d (skippedExists=%d, failed=%d)",
				n, len(toAdd), atomic.LoadInt64(&skippedExists), atomic.LoadInt64(&failed))
		}
	})

	return len(cands), len(toAdd), int(addedCount), nil
}

// RunAdopt is the CLI entry point for the sonarr-adopt subcommand.
func RunAdopt(args []string) {
	fs := flag.NewFlagSet("sonarr-adopt", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(adoptUsage) }

	var (
		location          = fs.String("location", "", "")
		libraryPath       = fs.String("library-path", "", "")
		rootFolder        = fs.String("root-folder", "", "")
		monitored         = fs.String("monitored", "true", "")
		search            = fs.Bool("search", false, "")
		seasonFolder      = fs.String("season-folder", "true", "")
		seriesType        = fs.String("series-type", "standard", "")
		qualityProfile    = fs.Int("quality-profile", 1, "")
		languageProfile   = fs.Int("language-profile", 1, "")
		dryRun            = fs.Bool("dry-run", false, "")
		lookupConcurrency = fs.Int("lookup-concurrency", 10, "")
		addConcurrency    = fs.Int("add-concurrency", 2, "")
		statePath         = fs.String("state", filepath.Join("output", "sonarr-adopt-state.json"), "")
		cachePath         = fs.String("cache", filepath.Join("output", "sonarr-lookup-cache.json"), "")
		help              = fs.Bool("help", false, "")
	)
	_ = fs.Parse(args)

	if *help {
		fmt.Print(adoptUsage)
		return
	}

	log := logger.New("")
	defer log.Close()

	baseURL := os.Getenv("SONARR_URL")
	apiKey := os.Getenv("SONARR_API_KEY")

	lib := *location
	if lib == "" {
		lib = *libraryPath
	}
	root := *location
	if root == "" {
		root = *rootFolder
	}

	if baseURL == "" || apiKey == "" {
		log.Error("Missing env vars: SONARR_URL and/or SONARR_API_KEY")
		os.Exit(2)
	}
	if lib == "" || root == "" {
		log.Error("Missing required args: --location (or --library-path / --root-folder)")
		fmt.Print(adoptUsage)
		os.Exit(2)
	}

	opts := AdoptOptions{
		BaseURL:             baseURL,
		APIKey:              apiKey,
		LibraryPath:         lib,
		RootFolderPath:      root,
		Monitored:           *monitored != "false",
		SearchForMissingEps: *search,
		SeasonFolder:        *seasonFolder != "false",
		SeriesType:          *seriesType,
		QualityProfileID:    *qualityProfile,
		LanguageProfileID:   *languageProfile,
		DryRun:              *dryRun,
		LookupConcurrency:   *lookupConcurrency,
		AddConcurrency:      *addConcurrency,
		StatePath:           *statePath,
		CachePath:           *cachePath,
	}

	c, prep, addedN, err := AdoptLibrary(opts, log)
	if err != nil {
		log.Errorf("sonarr-adopt failed: %v", err)
		os.Exit(1)
	}
	log.Infof("Done. candidates=%d prepared=%d added=%d", c, prep, addedN)
}
