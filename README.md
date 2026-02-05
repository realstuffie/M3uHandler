<p align="center-left">
  <img src="assets/logo.svg" alt="m3uHandler logo" width="200" />
</p>

# m3uHandler

Turn an IPTV-style M3U/M3U8 playlist into a media-server-friendly folder of `.strm` files.

`m3uHandler` reads a playlist, categorizes entries into **Movies**, **TV Shows**, and optionally **Live**, then writes a clean directory structure that Emby/Jellyfin/Kodi/etc can scan.

## What it does (at a glance)

- **Movies**
  - Default: `Movies/<Year>/<Title>.strm` (example: `Movies/2023/My Movie.strm`)
  - Optional layouts: “flat” (`Movies/My Movie.strm`) or “by folder” (`Movies/My Movie/My Movie.strm`)
- **TV Shows**
  - `TV Shows/<Show>/Season 01/S01E01 - Episode.strm`
  - Treats the TV shows URL as multiple paginated links
- **Live**
  - Ignored by default (enable via `--include-live`)

## Prerequisites

- Node.js **18+**

## Install

```bash
npm install
```

Optional helper (mainly useful in CI because it switches to `npm ci` automatically):

```bash
npm run install-deps
```

What `npm run install-deps` does:

- Windows: runs `npm.cmd`
- macOS/Linux: runs `npm`
- If `CI` is set: runs `npm ci`
- Otherwise: runs `npm install`

## Logging

All CLIs write logs to both the console and a log file.

- Default log path: `output/m3uHandler.log`
- Override via environment variable: `M3UHANDLER_LOG_PATH`

Example:

```bash
M3UHANDLER_LOG_PATH="output/custom.log" node src/daemon.js --url "<m3u_url>" --once
```

## Quick start

Install as a CLI:

```bash
npm install -g m3uhandler
```

Run one-time (fetch playlist, generate `.strm` files, then exit):

```bash
m3uhandler --url "<m3u_url>" --once
```

Daemon mode (poll periodically):

```bash
m3uhandler --url "<m3u_url>" [options]
```

(Dev usage without installing globally: `node src/daemon.js ...`)

### Notes

- Built around ApolloGroupTV-style playlists, but may work with other providers.
- The main entrypoint is the **daemon-style CLI**: `src/daemon.js`.

### Options (daemon)

| Flag | Alias | Description | Default |
|---|---|---|---|
| `--url <url>` | — | Playlist URL to fetch (omit if using `--use-config`) | — |
| `--use-config` | — | Load URL + settings from plaintext config (`~/.config/m3uHandler/config.json`) | `false` |
| `--out <dir>` | `-o` | Output directory (default: `output`, overridden by config) | `output` |
| `--include-live` | — | Also write live `.strm` entries (overridden by config) | `false` |
| `--movies-flat` | — | Put movies directly under `Movies/` (no `Movies/<Year>/`) (overridden by config) | `false` |
| `--movies-by-folder` | — | Put movies under `Movies/<Movie Name>/<Movie Name>.strm` (overridden by config) | `false` |
| `--no-delete-missing` | — | Do not delete `.strm` files missing from latest playlist | — |
| `--interval-hours <n>` | — | Poll interval in hours (default: `24`, overridden by config) | `24` |
| `--interval-seconds <n>` | — | Poll interval in seconds (overrides hours) | — |
| `--once` | — | Run one update and exit | `false` |
| `--help` | `-h` | Show help | — |

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

- `<location>/Movie Title (2010)/...` (folder per movie)

Pass `--location <path>` to `radarr-adopt` to set `<location>` explicitly.

The script parses `Title (Year)` from the folder name, uses Radarr’s lookup endpoint to resolve the TMDb ID, then POSTs to Radarr in batches (default: **1000**).

### Run

Set environment variables:

- `RADARR_URL` (example: `http://[your local radarr ip]:7878`)
- `RADARR_API_KEY` (Radarr → Settings → General → Security)

Dry-run (no API calls to add movies):

```bash
RADARR_URL="http://[your local radarr ip]:7878" RADARR_API_KEY="..." \
  npm run radarr-adopt -- --location "[your movies folder]" --dry-run
```

Actual import (batch size 1000):

```bash
RADARR_URL="http://[your local radarr ip]:7878" RADARR_API_KEY="..." \
  npm run radarr-adopt -- --location "[your movies folder]" --batch-size 1000
```

Notes:

- The `--root-folder` value **must** match a configured Radarr root folder.
- The script defaults to `monitored=true` and does **not** trigger automatic searching/downloading unless you pass `--search`.
- Resume support: state is written to `output/radarr-adopt-state.json` so you can re-run and it will skip already-added paths.

## Useful npm scripts

- `npm run daemon` — run the main daemon CLI (`node src/daemon.js`)
- `npm run radarr-csv` — generate a Radarr TMDb List import CSV (`node src/radarr-csv.js`)
- `npm run radarr-adopt` — bulk-adopt an existing movie folder into Radarr via API (`node src/radarr-adopt.js`)
- `npm run install-deps` — wrapper around npm install / npm ci (`node src/install-deps.js`)
- `npm test` — run tests (`node --test`)
