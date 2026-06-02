// SPDX-License-Identifier: GPL-3.0-or-later
package radarr

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"m3uhandler/internal/logger"
)

const csvUsage = `radarr-csv - Generate a Radarr-compatible TMDb CSV from an M3U file

Usage:
  m3uhandler radarr-csv --input <playlist.m3u> [options]

Options:
  -i, --input <path>        Input M3U/M3U8 file (required)
  -o, --output <path>       Output CSV path (default: output/radarr.csv)
      --default-year <year> Year to use when none is detected
  -h, --help                Show this help
`

var yearSuffixRe = regexp.MustCompile(`\((\d{4})\)\s*$`)
var attrReCSV = regexp.MustCompile(`([\w-]+)="([^"]*)"`)

func csvEscape(s string) string {
	if strings.ContainsAny(s, `",`+"\r\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func parseExtinfCSV(line string) (attrs map[string]string, displayName string) {
	commaIdx := strings.LastIndex(line, ",")
	attrPart := line
	if commaIdx >= 0 {
		displayName = strings.TrimSpace(line[commaIdx+1:])
		attrPart = line[:commaIdx]
	}
	attrs = map[string]string{}
	for _, m := range attrReCSV.FindAllStringSubmatch(attrPart, -1) {
		attrs[m[1]] = m[2]
	}
	return
}

func parseYearCSV(title string) string {
	m := yearSuffixRe.FindStringSubmatch(title)
	if m != nil {
		return m[1]
	}
	return ""
}

func parseMovieTitle(displayName string) string {
	s := yearSuffixRe.ReplaceAllString(strings.TrimSpace(displayName), "")
	return strings.TrimSpace(s)
}

// GenerateCSV reads an M3U and writes a Radarr TMDb-list CSV (Title, Year, TmdbId).
func GenerateCSV(inputPath, outputPath, defaultYear string) (int, error) {
	f, err := os.Open(inputPath)
	if err != nil {
		return 0, fmt.Errorf("INPUT_NOT_FOUND: %s", inputPath)
	}
	defer f.Close()

	rows := []string{"Title,Year,TmdbId"}
	var pending *string

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			l := line
			pending = &l
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		if pending == nil {
			continue
		}

		attrs, displayName := parseExtinfCSV(*pending)
		pending = nil

		t := strings.ToLower(attrs["tvg-type"])
		if t != "" && t != "movie" && t != "movies" {
			continue
		}

		year := parseYearCSV(displayName)
		if year == "" {
			year = defaultYear
		}
		title := parseMovieTitle(displayName)
		if title == "" {
			title = attrs["tvg-name"]
		}
		if title == "" {
			continue
		}

		rows = append(rows, fmt.Sprintf("%s,%s,", csvEscape(title), csvEscape(year)))
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}

	csv := strings.Join(rows, "\n") + "\n"
	movieCount := len(rows) - 1 // subtract header

	if outputPath == "" {
		fmt.Print(csv)
		return movieCount, nil
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return 0, err
	}
	if err := os.WriteFile(outputPath, []byte(csv), 0o644); err != nil {
		return 0, err
	}
	return movieCount, nil
}

// RunCSV is the CLI entry point for the radarr-csv subcommand.
func RunCSV(args []string) {
	fs := flag.NewFlagSet("radarr-csv", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(csvUsage) }

	var (
		input       = fs.String("input", "", "")
		output      = fs.String("output", "output/radarr.csv", "")
		defaultYear = fs.String("default-year", "", "")
		help        = fs.Bool("help", false, "")
	)
	fs.StringVar(input, "i", "", "")
	fs.StringVar(output, "o", "output/radarr.csv", "")
	_ = fs.Parse(args)

	if *help {
		fmt.Print(csvUsage)
		return
	}

	log := logger.New("")

	if *input == "" {
		log.Error("Missing --input. Example: m3uhandler radarr-csv --input playlist.m3u --output output/radarr.csv")
		os.Exit(2)
	}

	log.Infof("Generating Radarr CSV... Log: %s", log.LogPath)
	n, err := GenerateCSV(*input, *output, *defaultYear)
	if err != nil {
		log.Errorf("Failed to generate Radarr CSV: %v", err)
		os.Exit(1)
	}
	log.Infof("Wrote Radarr CSV (%d movies): %s", n, *output)
}
