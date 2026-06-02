# m3uHandler (Go rewrite)

Turn an IPTV-style M3U/M3U8 playlist into a media-server-friendly folder of `.strm` files.

Reads a playlist, categorises entries into **Movies**, **TV Shows**, **Sports VOD**, and optionally **Live**, then writes a clean directory structure that Emby / Jellyfin / Plex / Kodi can scan.

## Prerequisites

- Go **1.22+**

## Build

```bash
go build -o m3uhandler .
```

## Subcommands

| Subcommand | Description |
| --- | --- |
| `daemon` | Fetch playlist(s) and write `.strm` files, optionally on a schedule |
| `radarr-csv` | Generate a Radarr TMDb List CSV from a movies playlist |
| `radarr-adopt` | Bulk-import an existing movie library into Radarr via API |
| `sonarr-adopt` | Bulk-import an existing TV library into Sonarr via API |

---

## daemon

Fetches one or more playlist URLs and writes `.strm` files. Runs once or on a repeating interval.

### Directory layout

| Type | Layout |
| --- | --- |
| Movies (default) | `Movies/<Year>/<Title>.strm` |
| `--movies-flat` | `Movies/<Title>.strm` |
| `--movies-by-folder` | `Movies/<Title>/<Title>.strm` |
| `--movies-by-year-folder` | `Movies/<Year>/<Title>/<Title>.strm` |
| TV Shows | `TV Shows/<Show>/Season 01/<Show> S01E01.strm` |
| Live | `Live/<Group>/<Channel>.strm` |
| Sports VOD | `Sports VOD/<Group>/<Event>.strm` |

### Usage

```bash
./m3uhandler daemon [options]
```

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--url <url>` | Generic playlist URL | — |
| `--url-tv <url>` | TV shows URL; if URL ends with a number it auto-paginates until a 4xx | — |
| `--url-movies <url>` | Movies URL (single, no pagination) | — |
| `--url-events <url>` | Sports VOD / events URL (single, no pagination) | — |
| `--use-config` | Load URLs + settings from `~/.config/m3uHandler/config.json` | `false` |
| `-o, --out <dir>` | Output directory | `output` |
| `--include-live` | Also write live `.strm` entries | `false` |
| `--movies-flat` | Put movies directly under `Movies/` | `false` |
| `--movies-by-folder` | `Movies/<Title>/<Title>.strm` | `false` |
| `--movies-by-year-folder` | `Movies/<Year>/<Title>/<Title>.strm` | `false` |
| `--no-delete-missing` | Do not delete `.strm` files absent from latest playlist | `false` |
| `--no-overwrite` | Skip writing a `.strm` that already exists on disk | `false` |
| `--skip-if-media-exists` | Skip if a local media file with the same base name exists | `false` |
| `--write-concurrency <n>` | Parallel `.strm` writers | `8` |
| `--progress-every <n>` | Log progress every N entries | `1000` |
| `--interval-hours <n>` | Poll interval in hours | `24` |
| `--interval-seconds <n>` | Poll interval in seconds (overrides hours) | — |
| `--once` | Run one update and exit | `false` |
| `-h, --help` | Show help | — |

**Environment variables:**

- `FETCH_TIMEOUT_MS` — HTTP fetch timeout in milliseconds (default: `300000` / 5 min)
- `M3UHANDLER_LOG_PATH` — override log file path (default: `output/m3uHandler.log`)

### Examples

**Movies only (year+folder layout, skip already-downloaded):**

```bash
./m3uhandler daemon \
  --url-movies "https://provider/api/list/USER/PASS/m3u8/movies" \
  --once -o /mnt/media/ \
  --movies-by-year-folder \
  --skip-if-media-exists \
  --no-delete-missing
```

**TV shows (auto-paginates from page 1 until 4xx):**

```bash
./m3uhandler daemon \
  --url-tv "https://provider/api/list/USER/PASS/m3u8/tvshows/1" \
  --once -o /mnt/media/ \
  --no-delete-missing
```

**Sports VOD:**

```bash
./m3uhandler daemon \
  --url-events "https://provider/api/list/USER/PASS/m3u8/events" \
  --once -o /mnt/media/ \
  --no-delete-missing
```

**All sources, daemon mode (refresh every 24h):**

```bash
./m3uhandler daemon \
  --url-tv "https://provider/api/list/USER/PASS/m3u8/tvshows/1" \
  --url-movies "https://provider/api/list/USER/PASS/m3u8/movies" \
  --url-events "https://provider/api/list/USER/PASS/m3u8/events" \
  -o /mnt/media/ \
  --movies-by-year-folder \
  --skip-if-media-exists \
  --no-overwrite \
  --no-delete-missing \
  --interval-hours 24
```

---

## radarr-csv

Generate a Radarr-compatible TMDb List CSV from a movies playlist.

```bash
./m3uhandler radarr-csv --input /path/to/playlist.m3u8 --output output/radarr.csv
```

---

## radarr-adopt

Bulk-import an existing movie library into Radarr via API, bypassing the GUI importer.

Expects folders named `Title (Year)` directly under `--location`, or one level deeper (e.g. year sub-folders) when `--recursive` is set.

**Environment variables:**

- `RADARR_URL` — e.g. `http://192.168.1.10:7878`
- `RADARR_API_KEY` — Radarr → Settings → General → Security

### Usage

```bash
RADARR_URL="http://..." RADARR_API_KEY="..." \
  ./m3uhandler radarr-adopt --location "/mnt/media/Movies" [options]
```

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--location <path>` | Library root (scan path + Radarr rootFolderPath) | required |
| `--library-path <path>` | Override scan location only | — |
| `--root-folder <path>` | Override Radarr rootFolderPath only | — |
| `--recursive` | Also scan one level of subdirectories (e.g. year folders) | `false` |
| `--monitored <true\|false>` | Mark movies as monitored | `true` |
| `--search` | Trigger search for missing movies after add | `false` |
| `--dry-run` | Scan and prepare only; no API calls | `false` |
| `--lookup-concurrency <n>` | Parallel TMDb lookup requests | `10` |
| `--add-concurrency <n>` | Parallel add requests | `2` |
| `--state <path>` | Resume state file | `output/radarr-adopt-state.json` |
| `--cache <path>` | Lookup cache file | `output/radarr-lookup-cache.json` |

### Example (year-folder layout)

```bash
RADARR_URL="http://192.168.1.10:7878" RADARR_API_KEY="..." \
  ./m3uhandler radarr-adopt --location "/mnt/media/Movies" --recursive
```

**Notes:**

- Progress logged every 200 TMDb lookups.
- Lookup cache saved every 200 lookups — run is resumable.
- Already-added paths tracked in state file; re-running skips them.

---

## sonarr-adopt

Bulk-import an existing TV library into Sonarr via API.

Expects folders named `Title (Year)` or `Title` directly under `--location`.

**Environment variables:**

- `SONARR_URL` — e.g. `http://192.168.1.10:8989`
- `SONARR_API_KEY` — Sonarr → Settings → General → Security

### Usage

```bash
SONARR_URL="http://..." SONARR_API_KEY="..." \
  ./m3uhandler sonarr-adopt --location "/mnt/media/TV Shows" [options]
```

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--location <path>` | Library root (scan path + Sonarr rootFolderPath) | required |
| `--library-path <path>` | Override scan location only | — |
| `--root-folder <path>` | Override Sonarr rootFolderPath only | — |
| `--monitored <true\|false>` | Mark series as monitored | `true` |
| `--search` | Trigger search for missing episodes after add | `false` |
| `--season-folder <true\|false>` | Organise episodes into season sub-folders | `true` |
| `--series-type <type>` | `standard`, `daily`, or `anime` | `standard` |
| `--quality-profile <n>` | Quality profile ID | `1` |
| `--language-profile <n>` | Language profile ID | `1` |
| `--dry-run` | Scan and prepare only; no API calls | `false` |
| `--lookup-concurrency <n>` | Parallel TVDB lookup requests | `10` |
| `--add-concurrency <n>` | Parallel add requests | `2` |
| `--state <path>` | Resume state file | `output/sonarr-adopt-state.json` |
| `--cache <path>` | Lookup cache file | `output/sonarr-lookup-cache.json` |

**Notes:**

- Progress logged every 200 TVDB lookups.
- Lookup cache saved every 200 lookups — run is resumable.
- Already-added paths tracked in state file; re-running skips them.

---

## Logging

All subcommands write logs to both stdout and a file.

- Default log path: `output/m3uHandler.log`
- Override: `M3UHANDLER_LOG_PATH=<path>`
