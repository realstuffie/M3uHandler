# m3uHandler

## Proprietary Notice

Copyright (c) 2026 mooresolutions. All rights reserved.

This project is proprietary. No part of this repository may be copied, modified, published, distributed, sublicensed, and/or sold without prior written permission from mooresolutions.

See the `LICENSE` file for details.

---

CLI tool to split an ApolloGroupTV/Starlite style M3U/M3U8 playlist into individual `.strm` files, categorized for media libraries.

## What it generates

Default output under `output/`:

- TV Shows:
  - `output/TV Shows/<Show Name (Year)>/Season 01/<Show Name (Year)> S01E01.strm`
- Movies (by year):
  - `output/Movies/<Year>/<Movie Name (Year)>.strm`
- Live (optional):
  - `output/Live/<Group Title>/<Channel Name>.strm`

Each `.strm` file contains the **stream URL** on a single line.

## Windows Quick Start

1) Install Node + repo deps (best-effort, uses winget if needed):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\\windows\\bootstrap.ps1
```

2) Set admin password:
```powershell
npm run gui-user -- set --username admin --password "ChangeMeNow"
```

3) Start GUI (LAN):
```powershell
$env:GUI_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
$env:GUI_HOST = "0.0.0.0"
npm run gui
```

If LAN access is blocked, run (as Administrator):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\\windows\\open-firewall.ps1 -Port 5177
```

## Install dependencies

Cross-platform (requires Node.js + npm already installed):

```bash
npm run install-deps
```

Windows (best-effort bootstrap with winget):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\\windows\\bootstrap.ps1
```

## Usage (CLI)

```bash
node src/index.js --input /path/to/playlist.m3u8
```

## Usage (GUI)

Start the local web app (localhost only by default):

Linux/macOS:
```bash
GUI_SESSION_SECRET="$(openssl rand -hex 32)" npm run gui
```

Windows PowerShell:
```powershell
$env:GUI_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
npm run gui
```

LAN access (bind to all interfaces):

Linux/macOS:
```bash
GUI_SESSION_SECRET="$(openssl rand -hex 32)" GUI_HOST=0.0.0.0 npm run gui
```

Windows PowerShell:
```powershell
# Note: on Windows the app will attempt to add an inbound firewall rule automatically when GUI_HOST=0.0.0.0.
# This requires Administrator. If it fails, run PowerShell as Administrator and run:
#   powershell -ExecutionPolicy Bypass -File scripts\\windows\\open-firewall.ps1 -Port 5177
# Or run directly:
#   netsh advfirewall firewall add rule name="m3uHandler GUI" dir=in action=allow protocol=TCP localport=5177
$env:GUI_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
$env:GUI_HOST = "0.0.0.0"
npm run gui
```

Then open:

- Local: http://127.0.0.1:5177
- LAN: `http://<your-lan-ip>:5177`

Upload your playlist, choose an output folder path (on the same machine running the GUI), and click **Convert**.

Options:

```bash
node src/index.js --help
```

Common examples:

```bash
# Choose output directory
node src/index.js -i playlist.m3u8 -o ./strm-out

# Include live channels too
node src/index.js -i playlist.m3u8 --include-live

# Overwrite existing .strm files
node src/index.js -i playlist.m3u8 --overwrite

# Movies without year folders
node src/index.js -i playlist.m3u8 --movies-flat

# Preview without writing
node src/index.js -i playlist.m3u8 --dry-run
```

## Daemon (auto-update from URL)

### GUI daemon mode (TV + Movies)

The GUI daemon supports **two concurrent jobs** with separate URLs:

- TV: `.../m3u8/tvshows` (paged automatically: `/tvshows/1..N` until 404, cap=50)
- Movies: `.../m3u8/movies` (single URL)

Both write into the same output root under:
- `TV Shows/`
- `Movies/`

Ignored entries are logged to:
- `output/.logs/tv-ignored.ndjson`
- `output/.logs/movies-ignored.ndjson`

Each ignored log line contains JSON with `displayName`, `tvgType`, `groupTitle`, `tvgName`, `url`, and a reason.

Type inference:
- If `tvg-type` is missing, the TV job assumes `tvshows`, and the Movies job assumes `movies`.

-------

### Option 1: Pass URL directly (no saving)

```bash
npm run daemon -- --url "https://example.com/playlist.m3u8" -o ./output
```

### Option 2: Save URL to a hidden config file (plaintext)

This keeps the URL out of your terminal history and out of the GUI after first save.

Config file:
- `~/.config/m3uHandler/config.json`

Create/update it:

```bash
npm run config -- init --url "https://example.com/playlist.m3u8" --out ./output --interval-hours 24
```

Run daemon from config:

```bash
npm run daemon -- --use-config
```

Runs forever (until stopped), fetching the playlist URL and regenerating `.strm` files every 24 hours by default, **deleting missing** `.strm` files to keep the library in sync.

Common options:

```bash
# Run once and exit (useful for cron)
npm run daemon -- --url "https://example.com/playlist.m3u8" --once

# Change interval (hours)
npm run daemon -- --url "https://example.com/playlist.m3u8" --interval-hours 6

# Do not delete missing files
npm run daemon -- --url "https://example.com/playlist.m3u8" --no-delete-missing
```

Security note: if your URL contains credentials, avoid pasting it into screenshots/logs. The daemon logs a redacted URL.

## Notes

- TV parsing accepts titles like: `Show Name (2026) S01E01` and `Show Name (2026) S01 E101`.
- If an episode tag can’t be detected but `tvg-name` exists, a fallback file is written: `TV Shows/<Show>/<tvg-name>.strm`.
- TV show pages: if your provider uses `.../tvshows/1`, `.../tvshows/2`, etc, you can enter either `.../tvshows` or `.../tvshows/` in the GUI and it will page automatically.
- Movie year is extracted from `(YYYY)` at end of the title, otherwise from `group-title` containing a year like `Movies 2025`.
- Filenames are sanitized for Windows compatibility.