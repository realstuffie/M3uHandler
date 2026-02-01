# m3uHandler

A command-line utility to process M3U/M3U8 playlists and organize their entries into structured `.strm` files for media servers.

## Overview

This tool parses a master M3U playlist and categorizes each entry into `Movies`, `TV Shows`, or `Live` streams. It then creates a directory structure and writes individual `.strm` files, which are recognized by many media server applications.

- Movies are organized by year (e.g., `Movies/2023/My Movie.strm`) by default.
- Movies can also be organized “flat” (e.g., `Movies/My Movie.strm`) or “by folder” (e.g., `Movies/My Movie/My Movie.strm`).
- TV shows are organized by show name and season (e.g., `TV Shows/My Show/Season 01/S01E01 - Pilot.strm`). Treats the TV shows URL as multiple paginated links.
- Live streams are typically ignored unless specified.

## Prerequisites

- Node.js version 18 or higher.

## Installation

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

*(Note: there is an `npm run install-deps` helper script, but `npm install` is enough for standard setups.)*

## Logging

All CLIs write logs to both the console and a log file.

- Default log path: `output/m3uHandler.log`
- Override via environment variable: `M3UHANDLER_LOG_PATH`

Example:

```bash
M3UHANDLER_LOG_PATH="output/custom.log" node src/daemon.js --url "<m3u_url>" --once
```

## Usage

This tool is designed to be used with ApolloGroupTV M3U files, but may work for other providers.

The project currently exposes a **daemon-style CLI** (`src/daemon.js`) which periodically fetches an M3U URL and generates `.strm` files. (The `package.json` mentions `src/index.js` / `src/config.js`, but those entrypoints are not present in this repo.)

### Run (single update)

```bash
node src/daemon.js --url "<m3u_url>" --once
```

### Run (daemon mode)

```bash
node src/daemon.js --url "<m3u_url>" [options]
```

### Options (daemon)

|  Flag  |  Alias          | Description  |  Default  |
| `--url <url>`            | Playlist URL to fetch (omit if using `--use-config`)  |
| `--use-config`           | Load URL + settings from plaintext config (`~/.config/m3uHandler/config.json`)  | `false` |
| `--out <dir>` | `-o`     | Output directory (default: `output`, overridden by config)  | `output` |
| `--include-live`         | Also write live `.strm` entries (overridden by config)  | `false` |
| `--movies-flat`          | Put movies directly under `Movies/` (no `Movies/<Year>/`) (overridden by config)  | `false` |
| `--movies-by-folder`     | Put movies under `Movies/<Movie Name>/<Movie Name>.strm` (overridden by config)  | `false` |
| `--no-delete-missing`    | Do not delete `.strm` files missing from latest playlist
| `--interval-hours <n>`   | Poll interval in hours (default: `24`, overridden by config) | `24` |
| `--interval-seconds <n>` | Poll interval in seconds (overrides hours)
| `--once`                 | Run one update and exit | `false` |
| `--help` | `-h`          | Show help

## Radarr CSV export (TMDb List CSV)

This repo now includes a helper script to generate a Radarr-compatible CSV for **Settings → Lists → + → TMDb List → “Import List” (CSV)**.

It outputs:

- `Title`
- `Year`
- `TmdbId` (blank, since M3U playlists typically don’t provide it)

### Generate CSV

```bash
npm run radarr-csv -- --input /path/to/playlist.m3u --output output/radarr.csv
```

Optional: if the playlist does not include years in titles, you can set a default year:

```bash
npm run radarr-csv -- --input /path/to/playlist.m3u --output output/radarr.csv --default-year 2024
```

## Radarr bulk adopt (bypass GUI import)

If Radarr’s GUI “Library Import” errors out on very large libraries, you can bulk-add (“adopt”) existing movie folders via the Radarr API in batches.

This expects a folder layout like:

- `/mnt/share/Emby/Movies/Movies/Movie Title (2010)/...` (folder per movie)

The script parses `Title (Year)` from the folder name, uses Radarr’s lookup endpoint to resolve the TMDb ID, then POSTs to Radarr in batches (default: **1000**).

### Run

Set environment variables:

- `RADARR_URL` (example: `http://[your local radarr ip]:7878`)
- `RADARR_API_KEY` (Radarr → Settings → General → Security)

Dry-run (no API calls to add movies):

```bash
RADARR_URL="http://[your local radarr ip]:7878" RADARR_API_KEY="..." \
  npm run radarr-adopt -- --library-path "/mnt/share/Emby/Movies/Movies" --root-folder "/mnt/share/Emby/Movies/Movies" --dry-run
```

Actual import (batch size 1000):

```bash
RADARR_URL="http://[your local radarr ip]:7878" RADARR_API_KEY="..." \
  npm run radarr-adopt -- --library-path "/mnt/share/Emby/Movies/Movies" --root-folder "/mnt/share/Emby/Movies/Movies" --batch-size 1000
```

Notes:

- The `--root-folder` value **must** match a configured Radarr root folder.
- The script defaults to `monitored=true` and does **not** trigger automatic searching/downloading unless you pass `--search`.
- Resume support: state is written to `output/radarr-adopt-state.json` so you can re-run and it will skip already-added paths.

## Available Scripts

You can use `npm run <script-name>` to execute the following commands:

- `npm run daemon`: Runs the daemon CLI (`node src/daemon.js`).
- `npm run radarr-csv`: Generates a Radarr TMDb List import CSV from an M3U file (`node src/radarr-csv.js`).
- `npm run radarr-adopt`: Bulk-adopts an existing movie folder into Radarr via API (`node src/radarr-adopt.js`).
- `npm run install-deps`: Installs optional dependencies via `scripts/install-deps.js` (if present/needed).
- `npm test`: Currently not wired up (the repo contains tests, but `npm test` exits with "no test specified").
