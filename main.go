// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"os"

	"m3uhandler/internal/daemon"
	"m3uhandler/internal/radarr"
	"m3uhandler/internal/sonarr"
)

const usage = `m3uHandler - IPTV M3U to .strm file converter

Usage:
  m3uhandler <command> [options]

Commands:
  daemon        Periodically fetch an M3U URL and generate .strm files
  radarr-csv    Generate a Radarr-compatible CSV from an M3U file
  radarr-adopt  Bulk-import an existing movie library into Radarr
  sonarr-adopt  Bulk-import an existing TV library into Sonarr

Run 'm3uhandler <command> --help' for command-specific options.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "daemon":
		daemon.Run(args)
	case "radarr-csv":
		radarr.RunCSV(args)
	case "radarr-adopt":
		radarr.RunAdopt(args)
	case "sonarr-adopt":
		sonarr.RunAdopt(args)
	case "--help", "-h", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n%s", cmd, usage)
		os.Exit(1)
	}
}
