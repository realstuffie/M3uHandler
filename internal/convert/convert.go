// SPDX-License-Identifier: GPL-3.0-or-later
package convert

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
)

// Stats holds counters for a conversion run.
type Stats struct {
	Written int64
	Skipped int64
	Ignored int64
	Deleted int64
}

// LastWritten holds the last .strm file written.
type LastWritten struct {
	OutPath string
	URL     string
}

// MediaExts is the set of file extensions recognised as local media files.
// Checked (case-insensitively) when SkipIfMediaExists is true.
var MediaExts = map[string]struct{}{
	".mkv": {}, ".mp4": {}, ".avi": {}, ".mov": {}, ".wmv": {},
	".m4v": {}, ".mpg": {}, ".mpeg": {}, ".ts": {}, ".m2ts": {},
	".flv": {}, ".webm": {}, ".av1": {}, ".hevc": {}, ".h264": {},
	".rmvb": {}, ".divx": {}, ".xvid": {}, ".vob": {}, ".ogv": {},
}

// Options controls how the M3U is converted.
type Options struct {
	InputPath          string
	OutRoot            string
	IncludeLive        bool
	Overwrite          bool
	DryRun             bool
	MoviesByYear       bool
	MoviesByFolder     bool
	MoviesByYearFolder bool
	DeleteMissing      bool
	SkipIfMediaExists  bool   // skip .strm if a local media file with the same base name exists
	WriteConcurrency   int    // number of parallel file writers; 0 or 1 = sequential
	ProgressEvery      int    // log progress every N entries; 0 = disabled
	OnProgress         func(written, skipped, done, total int) // called every ProgressEvery completions
	IgnoredLogPath     string
	DefaultType        string // "tvshows" | "movies" | ""
}

// mediaCache caches the set of media base-names present in each directory,
// so that hasLocalMedia only calls os.ReadDir once per directory regardless
// of how many playlist entries share that output folder.
type mediaCache struct {
	mu    sync.Mutex
	dirs  map[string]map[string]struct{} // dir → set of base names (no ext) with media ext
}

func newMediaCache() *mediaCache {
	return &mediaCache{dirs: make(map[string]map[string]struct{})}
}

// has returns true if outDir contains a media file whose base name equals baseName.
func (c *mediaCache) has(outDir, baseName string) bool {
	c.mu.Lock()
	names, cached := c.dirs[outDir]
	if !cached {
		// Read once; subsequent callers for the same dir will use the cache.
		names = make(map[string]struct{})
		if entries, err := os.ReadDir(outDir); err == nil {
			for _, ent := range entries {
				if ent.IsDir() {
					continue
				}
				ext := strings.ToLower(filepath.Ext(ent.Name()))
				if _, ok := MediaExts[ext]; ok {
					base := strings.TrimSuffix(ent.Name(), filepath.Ext(ent.Name()))
					names[base] = struct{}{}
				}
			}
		}
		c.dirs[outDir] = names
	}
	c.mu.Unlock()
	_, found := names[baseName]
	return found
}

// Result is returned from ConvertM3U.
type Result struct {
	Stats       Stats
	LastWritten *LastWritten
}

// Package-level compiled regexes — compiled once at startup, reused for every entry.
var (
	attrRe        = regexp.MustCompile(`([\w-]+)="([^"]*)"`)
	illegalChars  = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1F]`)
	multiSpace    = regexp.MustCompile(`\s+`)
	yearSuffix    = regexp.MustCompile(`\((\d{4})\)\s*$`)
	yearInGroup   = regexp.MustCompile(`(\d{4})\b`) // was compiled inline per-entry — now package-level
	episodeRe     = regexp.MustCompile(`(?i)\bS(\d{1,2})\s*E(\d{1,3})\b`)
	episodeLongRe = regexp.MustCompile(`(?i)\bSeason\s*(\d{1,2})\s*(?:Episode|Ep)\s*(\d{1,3})\b`)
)

func sanitizeSegment(name string) string {
	s := illegalChars.ReplaceAllString(name, " ")
	s = multiSpace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

type extinf struct {
	attrs       map[string]string
	displayName string
}

func parseExtinf(line string) extinf {
	commaIdx := strings.LastIndex(line, ",")
	displayName := ""
	attrPart := line
	if commaIdx >= 0 {
		displayName = strings.TrimSpace(line[commaIdx+1:])
		attrPart = line[:commaIdx]
	}
	attrs := map[string]string{}
	for _, m := range attrRe.FindAllStringSubmatch(attrPart, -1) {
		attrs[m[1]] = m[2]
	}
	return extinf{attrs: attrs, displayName: displayName}
}

func parseYearFromTitle(title string) string {
	if m := yearSuffix.FindStringSubmatch(title); m != nil {
		return m[1]
	}
	return ""
}

type episodeInfo struct {
	showBase       string
	season         string
	kodiEpisodeTag string
}

func parseShowTitleAndEpisode(displayName, fallbackGroupTitle string) episodeInfo {
	m := episodeRe.FindStringSubmatch(displayName)
	if m == nil {
		m = episodeLongRe.FindStringSubmatch(displayName)
	}

	var season, kodiTag string
	if m != nil {
		s := fmt.Sprintf("%02d", mustAtoi(m[1]))
		e := fmt.Sprintf("%02d", mustAtoi(m[2]))
		season = s
		kodiTag = "S" + s + "E" + e
	}

	var showBase string
	if fallbackGroupTitle != "" && yearSuffix.MatchString(fallbackGroupTitle) {
		showBase = fallbackGroupTitle
	}
	if showBase == "" {
		cleaned := episodeRe.ReplaceAllString(displayName, "")
		cleaned = episodeLongRe.ReplaceAllString(cleaned, "")
		showBase = strings.TrimSpace(cleaned)
	}

	return episodeInfo{showBase: showBase, season: season, kodiEpisodeTag: kodiTag}
}

func mustAtoi(s string) int {
	n := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		}
	}
	return n
}

// decideOutputPath returns a relative path for the .strm file, or "" to ignore.
func decideOutputPath(e extinf, opts *Options) string {
	rawType := strings.ToLower(e.attrs["tvg-type"])
	if rawType == "" {
		rawType = strings.ToLower(opts.DefaultType)
	}
	groupTitle := e.attrs["group-title"]
	if groupTitle == "" {
		groupTitle = "Unknown"
	}

	switch rawType {
	case "tvshows":
		info := parseShowTitleAndEpisode(e.displayName, groupTitle)

		if info.kodiEpisodeTag == "" && e.attrs["tvg-name"] != "" {
			showFolder := sanitizeSegment(info.showBase)
			if showFolder == "" {
				showFolder = sanitizeSegment(groupTitle)
			}
			if showFolder == "" {
				showFolder = "Unknown Show"
			}
			return filepath.Join("TV Shows", showFolder, sanitizeSegment(e.attrs["tvg-name"])+".strm")
		}
		if info.showBase == "" || info.season == "" || info.kodiEpisodeTag == "" {
			return ""
		}
		showFolder := sanitizeSegment(info.showBase)
		fileName := sanitizeSegment(info.showBase+" "+info.kodiEpisodeTag) + ".strm"
		return filepath.Join("TV Shows", showFolder, "Season "+info.season, fileName)

	case "movie", "movies":
		year := parseYearFromTitle(e.displayName)
		if year == "" {
			if m := yearInGroup.FindStringSubmatch(groupTitle); m != nil {
				year = m[1]
			}
		}
		if year == "" {
			year = "Unknown"
		}
		movieName := sanitizeSegment(e.displayName)
		if movieName == "" {
			movieName = sanitizeSegment(e.attrs["tvg-name"])
		}
		if movieName == "" {
			movieName = "Unknown Movie"
		}
		switch {
		case opts.MoviesByYearFolder:
			return filepath.Join("Movies", year, movieName, movieName+".strm")
		case opts.MoviesByFolder:
			return filepath.Join("Movies", movieName, movieName+".strm")
		case opts.MoviesByYear:
			return filepath.Join("Movies", year, movieName+".strm")
		default:
			return filepath.Join("Movies", movieName+".strm")
		}

	case "live":
		if !opts.IncludeLive {
			return ""
		}
		channel := sanitizeSegment(e.displayName)
		if channel == "" {
			channel = sanitizeSegment(e.attrs["tvg-name"])
		}
		if channel == "" {
			channel = "Unknown Channel"
		}
		group := sanitizeSegment(groupTitle)
		if group == "" {
			group = "Live"
		}
		return filepath.Join("Live", group, channel+".strm")

	case "events", "sports":
		event := sanitizeSegment(e.displayName)
		if event == "" {
			event = sanitizeSegment(e.attrs["tvg-name"])
		}
		if event == "" {
			event = "Unknown Event"
		}
		group := sanitizeSegment(groupTitle)
		if group == "" {
			group = "Sports VOD"
		}
		return filepath.Join("Sports VOD", group, event+".strm")
	}
	return ""
}

type ignoredEntry struct {
	DisplayName string `json:"displayName"`
	TvgType     string `json:"tvgType"`
	GroupTitle  string `json:"groupTitle"`
	TvgName     string `json:"tvgName"`
	URL         string `json:"url"`
	Reason      string `json:"reason"`
}

// writeTask is a resolved entry ready to be written to disk.
type writeTask struct {
	outPath string
	url     string
}

// ConvertM3U parses an M3U file and writes .strm files under outRoot.
//
// Execution is split into two phases:
//  1. Sequential parse — reads the M3U line-by-line, resolves output paths,
//     and collects writeTask entries. Ignored entries are counted here.
//  2. Concurrent write — fans out the actual MkdirAll + WriteFile calls across
//     opts.WriteConcurrency goroutines (clamped to 1 when ≤ 0).
func ConvertM3U(opts Options) (Result, error) {
	if _, err := os.Stat(opts.InputPath); os.IsNotExist(err) {
		return Result{}, fmt.Errorf("INPUT_NOT_FOUND: %s", opts.InputPath)
	}

	f, err := os.Open(opts.InputPath)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()

	var ignoredW io.WriteCloser
	if opts.IgnoredLogPath != "" && !opts.DryRun {
		if err := os.MkdirAll(filepath.Dir(opts.IgnoredLogPath), 0o755); err == nil {
			if fw, err := os.OpenFile(opts.IgnoredLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				ignoredW = fw
			}
		}
	}
	if ignoredW != nil {
		defer ignoredW.Close()
	}

	// ---- Phase 1: sequential parse ----------------------------------------

	var (
		stats            Stats
		lastWritten      *LastWritten
		pending          *extinf
		tasks            []writeTask
		expectedRelPaths map[string]struct{}
	)
	if opts.DeleteMissing {
		expectedRelPaths = make(map[string]struct{}, 1024)
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			e := parseExtinf(line)
			pending = &e
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}

		if pending == nil {
			stats.Ignored++
			continue
		}

		url := line
		e := *pending
		pending = nil

		rel := decideOutputPath(e, &opts)
		if rel == "" {
			stats.Ignored++
			if ignoredW != nil {
				entry := ignoredEntry{
					DisplayName: e.displayName,
					TvgType:     e.attrs["tvg-type"],
					GroupTitle:  e.attrs["group-title"],
					TvgName:     e.attrs["tvg-name"],
					URL:         url,
					Reason:      "No output path (unmatched type or missing SxxEyy for tvshows)",
				}
				if b, err := json.Marshal(entry); err == nil {
					_, _ = ignoredW.Write(append(b, '\n'))
				}
			}
			continue
		}

		outPath := filepath.Join(opts.OutRoot, rel)

		if expectedRelPaths != nil {
			expectedRelPaths[rel] = struct{}{}
		}

		if opts.DryRun {
			stats.Written++
			lastWritten = &LastWritten{OutPath: outPath, URL: url}
			continue
		}

		tasks = append(tasks, writeTask{outPath: outPath, url: url})
	}
	if err := scanner.Err(); err != nil {
		return Result{}, err
	}

	// ---- Phase 2: concurrent write -----------------------------------------

	concurrency := opts.WriteConcurrency
	if concurrency <= 0 {
		concurrency = 1
	}

	// dirOnce ensures MkdirAll is called exactly once per unique output
	// directory, and that all goroutines targeting that directory wait until
	// creation is confirmed before proceeding to WriteFile.
	type dirEntry struct {
		once sync.Once
		err  error
	}
	var dirCache sync.Map // map[string]*dirEntry

	var (
		mu       sync.Mutex // protects stats, lastWritten, firstErr
		firstErr error

		media   = newMediaCache() // read cache for SkipIfMediaExists
		doneCnt int64             // atomic completion counter for progress reporting
	)

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for _, task := range tasks {
		task := task
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			outDir := filepath.Dir(task.outPath)

			// LoadOrStore atomically assigns exactly one *dirEntry per outDir.
			// once.Do blocks all goroutines for the same dir until MkdirAll
			// completes, so WriteFile never races against directory creation.
			raw, _ := dirCache.LoadOrStore(outDir, &dirEntry{})
			de := raw.(*dirEntry)
			de.once.Do(func() {
				de.err = os.MkdirAll(outDir, 0o755)
			})
			if de.err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("mkdir %s: %w", outDir, de.err)
				}
				mu.Unlock()
				return
			}

			// Skip if a local media file already exists (read from cache).
			if opts.SkipIfMediaExists {
				base := strings.TrimSuffix(filepath.Base(task.outPath), ".strm")
				if media.has(outDir, base) {
					mu.Lock()
					stats.Skipped++
					mu.Unlock()
					goto progress
				}
			}

			if !opts.Overwrite {
				if _, err := os.Stat(task.outPath); err == nil {
					mu.Lock()
					stats.Skipped++
					mu.Unlock()
					goto progress
				}
			}

			if err := os.WriteFile(task.outPath, []byte(task.url+"\n"), 0o644); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("write %s: %w", task.outPath, err)
				}
				mu.Unlock()
				goto progress
			}

			mu.Lock()
			stats.Written++
			lastWritten = &LastWritten{OutPath: task.outPath, URL: task.url}
			mu.Unlock()

		progress:
			if opts.ProgressEvery > 0 && opts.OnProgress != nil {
				n := int(atomic.AddInt64(&doneCnt, 1))
				if n%opts.ProgressEvery == 0 || n == len(tasks) {
					mu.Lock()
					w, s := stats.Written, stats.Skipped
					mu.Unlock()
					opts.OnProgress(int(w), int(s), n, len(tasks))
				}
			}
		}()
	}
	wg.Wait()

	if firstErr != nil {
		return Result{}, firstErr
	}

	// ---- Phase 3: delete orphans -------------------------------------------

	if opts.DeleteMissing && expectedRelPaths != nil {
		for _, root := range []string{"TV Shows", "Movies", "Live"} {
			deleted, err := deleteOrphans(filepath.Join(opts.OutRoot, root), opts.OutRoot, expectedRelPaths)
			if err != nil {
				return Result{}, err
			}
			stats.Deleted += int64(deleted)
		}
	}

	return Result{Stats: stats, LastWritten: lastWritten}, nil
}

// deleteOrphans walks dir, removes .strm files absent from expected, and
// prunes any directories that become empty as a result.
func deleteOrphans(dir, outRoot string, expected map[string]struct{}) (int, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}

	deleted := 0
	for _, ent := range entries {
		full := filepath.Join(dir, ent.Name())
		if ent.IsDir() {
			n, err := deleteOrphans(full, outRoot, expected)
			if err != nil {
				return deleted, err
			}
			deleted += n
			remaining, _ := os.ReadDir(full)
			if len(remaining) == 0 {
				_ = os.Remove(full)
			}
		} else if strings.HasSuffix(strings.ToLower(ent.Name()), ".strm") {
			rel, _ := filepath.Rel(outRoot, full)
			if _, keep := expected[rel]; !keep {
				if os.Remove(full) == nil {
					deleted++
				}
			}
		}
	}
	return deleted, nil
}
