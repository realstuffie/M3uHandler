package convert

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sample is the same playlist used in the original JS test suite.
const sample = `#EXTM3U
#EXTINF:-1 tvg-id="tt37443891" tvg-name="tt37443891" tvg-type="movies" group-title="Movies 2025" ,Raat Akeli Hai - The Bansal Murders (2025)
https://starlite.best/api/list/username/password/m3u8/movies/tt37443891
#EXTINF:-1 tvg-id="tt33501959" tvg-name="tt33501959" tvg-type="tvshows" group-title="Land of Sin (2026)" ,Land of Sin (2026) S01 E01
https://starlite.best/api/list/username/password/m3u8/tvshows/tt33501959/1/1
#EXTINF:-1 tvg-id="tt22091076" tvg-name="tt22091076" tvg-type="tvshows" group-title="High Potential (2024)" ,High Potential (2024) S02 E01
https://starlite.best/api/list/username/password/m3u8/tvshows/tt22091076/2/1
#EXTINF:-1 tvg-id="5.star.max.eastern.us" tvg-name="5.star.max.eastern.us" tvg-type="live" group-title="US" tvg-logo="https://media.starlite.best/5.star.max.eastern.us.png",5 Star Max (East)
https://starlite.best/api/list/username/password/m3u8/livetv.epg/5.star.max.eastern.us.m3u8
`

func writeInput(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, "sample.m3u8")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}
	return p
}

func assertFileExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Errorf("expected file to exist: %s", path)
	}
}

func assertFileAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Errorf("expected file to be absent: %s", path)
	}
}

// ---- JS parity tests -------------------------------------------------------

// Test 1 (JS): generate movie+tv and ignore live when includeLive=false (dry-run)
func TestIgnoreLiveDryRun(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	res, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		IncludeLive:  false,
		Overwrite:    true,
		DryRun:       true,
		MoviesByYear: true,
		DeleteMissing: false,
		IgnoredLogPath: filepath.Join(dir, ".logs", "ignored.ndjson"),
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}
	if res.Stats.Written != 3 {
		t.Errorf("written: got %d, want 3", res.Stats.Written)
	}
	if res.Stats.Ignored != 1 {
		t.Errorf("ignored: got %d, want 1", res.Stats.Ignored)
	}
	if res.LastWritten == nil {
		t.Error("lastWritten should be non-nil")
	}
}

// Test 2 (JS): generate movie+tv+live when includeLive=true (dry-run)
func TestIncludeLiveDryRun(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	res, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		IncludeLive:  true,
		Overwrite:    true,
		DryRun:       true,
		MoviesByYear: true,
		DeleteMissing: false,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}
	if res.Stats.Written != 4 {
		t.Errorf("written: got %d, want 4", res.Stats.Written)
	}
	if res.Stats.Ignored != 0 {
		t.Errorf("ignored: got %d, want 0", res.Stats.Ignored)
	}
}

// Test 3 (JS): movie in its own folder when moviesByFolder=true
func TestMoviesByFolder(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	_, err := ConvertM3U(Options{
		InputPath:      in,
		OutRoot:        dir,
		IncludeLive:    false,
		Overwrite:      true,
		DryRun:         false,
		MoviesByYear:   true,
		MoviesByFolder: true,
		DeleteMissing:  false,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	movieName := "Raat Akeli Hai - The Bansal Murders (2025)"
	expected := filepath.Join(dir, "Movies", movieName, movieName+".strm")
	assertFileExists(t, expected)
}

// ---- Additional tests ------------------------------------------------------

// Movie by year (default): Movies/<Year>/<Title>.strm
func TestMoviesByYear(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	_, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		MoviesByYear: true,
		Overwrite:    true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	expected := filepath.Join(dir, "Movies", "2025", "Raat Akeli Hai - The Bansal Murders (2025).strm")
	assertFileExists(t, expected)
}

// Movie by year+folder: Movies/<Year>/<Title>/<Title>.strm
func TestMoviesByYearFolder(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	_, err := ConvertM3U(Options{
		InputPath:          in,
		OutRoot:            dir,
		MoviesByYearFolder: true,
		Overwrite:          true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	movieName := "Raat Akeli Hai - The Bansal Murders (2025)"
	expected := filepath.Join(dir, "Movies", "2025", movieName, movieName+".strm")
	assertFileExists(t, expected)
}

// TV show: TV Shows/<Show>/Season 01/<Show> S01E01.strm
func TestTVShowPath(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	_, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		MoviesByYear: true,
		Overwrite:    true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	// "Land of Sin (2026) S01 E01" → group-title "Land of Sin (2026)" → showBase from group
	show := "Land of Sin (2026)"
	expected := filepath.Join(dir, "TV Shows", show, "Season 01", show+" S01E01.strm")
	assertFileExists(t, expected)

	// "High Potential (2024) S02 E01"
	show2 := "High Potential (2024)"
	expected2 := filepath.Join(dir, "TV Shows", show2, "Season 02", show2+" S02E01.strm")
	assertFileExists(t, expected2)
}

// Live channel written when includeLive=true
func TestLiveWritten(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	_, err := ConvertM3U(Options{
		InputPath:   in,
		OutRoot:     dir,
		IncludeLive: true,
		Overwrite:   true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	expected := filepath.Join(dir, "Live", "US", "5 Star Max (East).strm")
	assertFileExists(t, expected)
}

// Overwrite=false: second run must not change an existing file.
func TestNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	opts := Options{
		InputPath:    in,
		OutRoot:      dir,
		MoviesByYear: true,
		Overwrite:    true,
	}
	if _, err := ConvertM3U(opts); err != nil {
		t.Fatalf("first run: %v", err)
	}

	// Overwrite the .strm with sentinel content.
	strmPath := filepath.Join(dir, "Movies", "2025", "Raat Akeli Hai - The Bansal Murders (2025).strm")
	sentinel := "sentinel-content\n"
	if err := os.WriteFile(strmPath, []byte(sentinel), 0o644); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}

	opts.Overwrite = false
	res, err := ConvertM3U(opts)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if res.Stats.Skipped == 0 {
		t.Error("expected at least one skipped file on second run with overwrite=false")
	}

	got, _ := os.ReadFile(strmPath)
	if string(got) != sentinel {
		t.Errorf("file was overwritten: got %q, want %q", got, sentinel)
	}
}

// DeleteMissing removes .strm files that are gone from the playlist.
func TestDeleteMissing(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	// First run writes all files.
	if _, err := ConvertM3U(Options{
		InputPath:     in,
		OutRoot:       dir,
		IncludeLive:   true,
		MoviesByYear:  true,
		Overwrite:     true,
		DeleteMissing: false,
	}); err != nil {
		t.Fatalf("first run: %v", err)
	}

	liveFile := filepath.Join(dir, "Live", "US", "5 Star Max (East).strm")
	assertFileExists(t, liveFile)

	// Second run with includeLive=false and deleteMissing=true should remove the live file.
	res, err := ConvertM3U(Options{
		InputPath:     in,
		OutRoot:       dir,
		IncludeLive:   false,
		MoviesByYear:  true,
		Overwrite:     true,
		DeleteMissing: true,
	})
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if res.Stats.Deleted == 0 {
		t.Error("expected at least one deletion")
	}
	assertFileAbsent(t, liveFile)
}

// defaultType="movies" treats entries with no tvg-type as movies.
func TestDefaultTypeMovies(t *testing.T) {
	dir := t.TempDir()
	// Entry has no tvg-type attribute.
	content := `#EXTM3U
#EXTINF:-1 tvg-name="The Matrix (1999)" group-title="Action 1999" ,The Matrix (1999)
https://example.com/matrix.m3u8
`
	in := writeInput(t, dir, content)

	_, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		MoviesByYear: true,
		Overwrite:    true,
		DefaultType:  "movies",
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	expected := filepath.Join(dir, "Movies", "1999", "The Matrix (1999).strm")
	assertFileExists(t, expected)
}

// Long-form episode notation "Season 1 Episode 2" is parsed correctly.
func TestLongFormEpisode(t *testing.T) {
	dir := t.TempDir()
	content := `#EXTM3U
#EXTINF:-1 tvg-type="tvshows" group-title="Firefly (2002)" ,Firefly (2002) Season 1 Episode 3
https://example.com/firefly.m3u8
`
	in := writeInput(t, dir, content)

	_, err := ConvertM3U(Options{
		InputPath: in,
		OutRoot:   dir,
		Overwrite: true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	show := "Firefly (2002)"
	expected := filepath.Join(dir, "TV Shows", show, "Season 01", show+" S01E03.strm")
	assertFileExists(t, expected)
}

// .strm file contains exactly the stream URL followed by a newline.
func TestStrmContent(t *testing.T) {
	dir := t.TempDir()
	const streamURL = "https://example.com/stream.m3u8"
	content := "#EXTM3U\n#EXTINF:-1 tvg-type=\"movies\" group-title=\"Movies 2020\" ,Test Movie (2020)\n" + streamURL + "\n"
	in := writeInput(t, dir, content)

	_, err := ConvertM3U(Options{
		InputPath:    in,
		OutRoot:      dir,
		MoviesByYear: true,
		Overwrite:    true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	strmPath := filepath.Join(dir, "Movies", "2020", "Test Movie (2020).strm")
	got, err := os.ReadFile(strmPath)
	if err != nil {
		t.Fatalf("read strm: %v", err)
	}
	if strings.TrimSpace(string(got)) != streamURL {
		t.Errorf(".strm content: got %q, want %q", got, streamURL+"\n")
	}
}

// SkipIfMediaExists: .strm is not written when a local media file with the
// same base name already exists in the output directory.
func TestSkipIfMediaExists(t *testing.T) {
	dir := t.TempDir()
	in := writeInput(t, dir, sample)

	// Pre-place a .mkv alongside where the movie .strm would land.
	movieDir := filepath.Join(dir, "Movies", "2025")
	if err := os.MkdirAll(movieDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	localMedia := filepath.Join(movieDir, "Raat Akeli Hai - The Bansal Murders (2025).mkv")
	if err := os.WriteFile(localMedia, []byte("fake"), 0o644); err != nil {
		t.Fatalf("write media: %v", err)
	}

	res, err := ConvertM3U(Options{
		InputPath:         in,
		OutRoot:           dir,
		MoviesByYear:      true,
		Overwrite:         true,
		SkipIfMediaExists: true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}

	// Movie should be skipped; the two TV shows still written.
	if res.Stats.Skipped != 1 {
		t.Errorf("skipped: got %d, want 1", res.Stats.Skipped)
	}
	if res.Stats.Written != 2 {
		t.Errorf("written: got %d, want 2 (TV shows only)", res.Stats.Written)
	}

	// .strm must NOT have been created next to the .mkv.
	strmPath := filepath.Join(movieDir, "Raat Akeli Hai - The Bansal Murders (2025).strm")
	assertFileAbsent(t, strmPath)
}

// dirSeen cache: many entries sharing the same output directory must not
// cause errors (regression guard for the MkdirAll cache).
func TestDirCacheWithManyEntries(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	lines = append(lines, "#EXTM3U")
	for i := 1; i <= 50; i++ {
		ep := fmt.Sprintf("%02d", i)
		lines = append(lines,
			`#EXTINF:-1 tvg-type="tvshows" group-title="Big Show (2020)" ,Big Show (2020) S01 E`+ep,
			"https://example.com/ep"+ep+".m3u8",
		)
	}
	in := writeInput(t, dir, strings.Join(lines, "\n")+"\n")

	res, err := ConvertM3U(Options{
		InputPath: in,
		OutRoot:   dir,
		Overwrite: true,
	})
	if err != nil {
		t.Fatalf("ConvertM3U: %v", err)
	}
	if res.Stats.Written != 50 {
		t.Errorf("written: got %d, want 50", res.Stats.Written)
	}
}
