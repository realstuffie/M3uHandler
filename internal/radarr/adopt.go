// SPDX-License-Identifier: GPL-3.0-or-later
package radarr

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

const adoptUsage = `radarr-adopt - Bulk-import an existing movie library into Radarr

Usage:
  RADARR_URL="http://127.0.0.1:7878" RADARR_API_KEY="..." \
    m3uhandler radarr-adopt --location "/mnt/movies"

Required:
  --location <path>            Library root. Used as scan path AND Radarr rootFolderPath.
                               Folders must be named "Title (Year)".

Optional:
  --library-path <path>        Override scan location (advanced)
  --root-folder <path>         Override Radarr rootFolderPath (advanced)
  --recursive                  Also scan one level of subdirectories (e.g. year folders)
  --monitored <true|false>     Default true
  --search                     Tell Radarr to search for missing movies after add
  --dry-run                    Scan and prepare only; do not call Radarr
  --lookup-concurrency <n>     Parallel lookup calls (default 10)
  --add-concurrency <n>        Parallel add calls (default 2)
  --state <path>               Resume state file (default output/radarr-adopt-state.json)
  --cache <path>               Lookup cache file (default output/radarr-lookup-cache.json)
  -h, --help                   Show this help
`

// ---- models ----------------------------------------------------------------

type radarrMovie struct {
	TmdbID int    `json:"tmdbId"`
	Path   string `json:"path"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
}

type lookupResult struct {
	TmdbID int    `json:"tmdbId"`
	Title  string `json:"title"`
	Year   int    `json:"year"`
}

type cacheEntry struct {
	TmdbID int    `json:"tmdbId"`
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
	year  int
	path  string
}

func scanDir(dir string) ([]candidate, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []candidate
	for _, ent := range entries {
		if !ent.IsDir() {
			continue
		}
		m := titleYearRe.FindStringSubmatch(ent.Name())
		if m == nil {
			continue
		}
		year, _ := strconv.Atoi(m[2])
		out = append(out, candidate{
			title: m[1],
			year:  year,
			path:  filepath.Join(dir, ent.Name()),
		})
	}
	return out, nil
}

func scanLibrary(libraryPath string, recursive bool) ([]candidate, error) {
	cands, err := scanDir(libraryPath)
	if err != nil {
		return nil, err
	}
	if !recursive {
		return cands, nil
	}
	// Also scan one level of subdirectories (e.g. year folders).
	top, err := os.ReadDir(libraryPath)
	if err != nil {
		return nil, err
	}
	for _, ent := range top {
		if !ent.IsDir() {
			continue
		}
		// Only recurse into dirs that look like year folders or don't match Title (Year).
		if titleYearRe.MatchString(ent.Name()) {
			continue // already picked up as a candidate above
		}
		sub, err := scanDir(filepath.Join(libraryPath, ent.Name()))
		if err != nil {
			continue // skip unreadable subdirs
		}
		cands = append(cands, sub...)
	}
	return cands, nil
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
		if e.ErrorCode == "MovieExistsValidator" {
			return true
		}
	}
	return false
}

// ---- adopt -----------------------------------------------------------------

// AdoptOptions controls the radarr-adopt run.
type AdoptOptions struct {
	BaseURL           string
	APIKey            string
	LibraryPath       string
	RootFolderPath    string
	Monitored         bool
	SearchForMovie    bool
	Recursive         bool
	DryRun            bool
	LookupConcurrency int
	AddConcurrency    int
	StatePath         string
	CachePath         string
}

// AdoptLibrary scans libraryPath, looks up movies in Radarr, and adds any
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
	log.Infof("Radarr rootFolderPath: %s", opts.RootFolderPath)
	log.Infof("monitored=%v | searchForMovie=%v | dryRun=%v | lookupConcurrency=%d | addConcurrency=%d",
		opts.Monitored, opts.SearchForMovie, opts.DryRun, opts.LookupConcurrency, opts.AddConcurrency)

	client := arr.NewClient(opts.BaseURL, opts.APIKey)

	existingByPath := map[string]radarrMovie{}
	existingByTmdb := map[int]radarrMovie{}

	if !opts.DryRun {
		logStage("Loading existing movies from Radarr")
		var existing []radarrMovie
		if err := client.GetJSON("/api/v3/movie", nil, &existing); err != nil {
			return 0, 0, 0, fmt.Errorf("list movies: %w", err)
		}
		for _, m := range existing {
			if m.Path != "" {
				existingByPath[m.Path] = m
			}
			if m.TmdbID != 0 {
				existingByTmdb[m.TmdbID] = m
			}
		}
		log.Infof("Loaded %d existing movies from Radarr.", len(existing))
	}

	logStage("Scanning library for \"Title (Year)\" folders")
	cands, err := scanLibrary(absLibrary, opts.Recursive)
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
	log.Infof("Found %d candidate movie folders to add.", len(filtered))

	// Determine which cache entries are missing.
	var missingIdx []int
	for i, c := range filtered {
		key := fmt.Sprintf("%s (%d)", c.title, c.year)
		if _, ok := lookupCache[key]; !ok && !opts.DryRun {
			missingIdx = append(missingIdx, i)
		}
	}

	logStage(fmt.Sprintf("TMDb lookup via Radarr (concurrency=%d)", opts.LookupConcurrency))
	var (
		lookupDone int64
		cacheMu    sync.Mutex
	)
	arr.MapConcurrent(len(missingIdx), opts.LookupConcurrency, func(j int) {
		i := missingIdx[j]
		c := filtered[i]
		key := fmt.Sprintf("%s (%d)", c.title, c.year)

		var results []lookupResult
		_ = arr.WithRetries(func() error {
			return client.GetJSON("/api/v3/movie/lookup",
				map[string]string{"term": fmt.Sprintf("%s %d", c.title, c.year)},
				&results)
		}, log)

		var entry *cacheEntry
		for _, r := range results {
			if r.Year == c.year {
				entry = &cacheEntry{TmdbID: r.TmdbID, Title: r.Title, Year: r.Year}
				break
			}
		}
		if entry == nil && len(results) > 0 {
			r := results[0]
			entry = &cacheEntry{TmdbID: r.TmdbID, Title: r.Title, Year: r.Year}
		}

		cacheMu.Lock()
		lookupCache[key] = entry
		n := atomic.AddInt64(&lookupDone, 1)
		if n%200 == 0 {
			_ = arr.WriteJSONAtomic(opts.CachePath, lookupCache)
			log.Infof("TMDb lookup progress: %d/%d", n, len(missingIdx))
		}
		cacheMu.Unlock()
	})
	log.Infof("TMDb lookup done: %d/%d", len(missingIdx), len(missingIdx))
	_ = arr.WriteJSONAtomic(opts.CachePath, lookupCache)

	// Build payloads from cache.
	type addOptions struct {
		SearchForMovie bool `json:"searchForMovie"`
	}
	type moviePayload struct {
		TmdbID           int        `json:"tmdbId"`
		Title            string     `json:"title"`
		Year             int        `json:"year"`
		QualityProfileID int        `json:"qualityProfileId"`
		RootFolderPath   string     `json:"rootFolderPath"`
		Path             string     `json:"path"`
		Monitored        bool       `json:"monitored"`
		AddOptions       addOptions `json:"addOptions"`
	}

	var toAdd []moviePayload
	for _, c := range filtered {
		key := fmt.Sprintf("%s (%d)", c.title, c.year)
		entry := lookupCache[key]
		if entry == nil || entry.TmdbID == 0 {
			continue
		}
		if !opts.DryRun {
			if _, exists := existingByTmdb[entry.TmdbID]; exists {
				continue
			}
		}
		p := moviePayload{
			TmdbID:           entry.TmdbID,
			Title:            entry.Title,
			Year:             entry.Year,
			QualityProfileID: 1,
			RootFolderPath:   opts.RootFolderPath,
			Path:             c.path,
			Monitored:        opts.Monitored,
		}
		p.AddOptions.SearchForMovie = opts.SearchForMovie
		toAdd = append(toAdd, p)
	}
	log.Infof("Prepared %d movies to add.", len(toAdd))

	if opts.DryRun {
		log.Infof("Dry-run: would add %d movies (no API calls)", len(toAdd))
		return len(cands), len(toAdd), len(toAdd), nil
	}

	logStage(fmt.Sprintf("Adding movies to Radarr (concurrency=%d)", opts.AddConcurrency))

	var (
		addedCount    int64
		skippedExists int64
		failed        int64
		stateMu       sync.Mutex
		existMu       sync.Mutex
	)

	arr.MapConcurrent(len(toAdd), opts.AddConcurrency, func(i int) {
		movie := toAdd[i]
		var result radarrMovie
		addErr := arr.WithRetries(func() error {
			return client.PostJSON("/api/v3/movie", movie, &result)
		}, log)

		if addErr != nil {
			if isAlreadyExistsErr(addErr) {
				atomic.AddInt64(&skippedExists, 1)
			} else {
				atomic.AddInt64(&failed, 1)
				log.Errorf("Failed to add %s: %v", movie.Path, addErr)
			}
		} else {
			existMu.Lock()
			if result.TmdbID != 0 {
				existingByTmdb[result.TmdbID] = result
			}
			if result.Path != "" {
				existingByPath[result.Path] = result
			}
			existMu.Unlock()
		}

		// Checkpoint the path regardless of outcome so we don't retry endlessly.
		p := result.Path
		if p == "" {
			p = movie.Path
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

// RunAdopt is the CLI entry point for the radarr-adopt subcommand.
func RunAdopt(args []string) {
	fs := flag.NewFlagSet("radarr-adopt", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(adoptUsage) }

	var (
		location          = fs.String("location", "", "")
		libraryPath       = fs.String("library-path", "", "")
		rootFolder        = fs.String("root-folder", "", "")
		recursive         = fs.Bool("recursive", false, "")
		monitored         = fs.String("monitored", "true", "")
		search            = fs.Bool("search", false, "")
		dryRun            = fs.Bool("dry-run", false, "")
		lookupConcurrency = fs.Int("lookup-concurrency", 10, "")
		addConcurrency    = fs.Int("add-concurrency", 2, "")
		statePath         = fs.String("state", filepath.Join("output", "radarr-adopt-state.json"), "")
		cachePath         = fs.String("cache", filepath.Join("output", "radarr-lookup-cache.json"), "")
		help              = fs.Bool("help", false, "")
	)
	_ = fs.Parse(args)

	if *help {
		fmt.Print(adoptUsage)
		return
	}

	log := logger.New("")
	defer log.Close()

	baseURL := os.Getenv("RADARR_URL")
	apiKey := os.Getenv("RADARR_API_KEY")

	lib := *location
	if lib == "" {
		lib = *libraryPath
	}
	root := *location
	if root == "" {
		root = *rootFolder
	}

	if baseURL == "" || apiKey == "" {
		log.Error("Missing env vars: RADARR_URL and/or RADARR_API_KEY")
		os.Exit(2)
	}
	if lib == "" || root == "" {
		log.Error("Missing required args: --location (or --library-path / --root-folder)")
		fmt.Print(adoptUsage)
		os.Exit(2)
	}

	opts := AdoptOptions{
		BaseURL:           baseURL,
		APIKey:            apiKey,
		LibraryPath:       lib,
		RootFolderPath:    root,
		Recursive:         *recursive,
		Monitored:         *monitored != "false",
		SearchForMovie:    *search,
		DryRun:            *dryRun,
		LookupConcurrency: *lookupConcurrency,
		AddConcurrency:    *addConcurrency,
		StatePath:         *statePath,
		CachePath:         *cachePath,
	}

	c, prep, addedN, err := AdoptLibrary(opts, log)
	if err != nil {
		log.Errorf("radarr-adopt failed: %v", err)
		os.Exit(1)
	}
	log.Infof("Done. candidates=%d prepared=%d added=%d", c, prep, addedN)
}
