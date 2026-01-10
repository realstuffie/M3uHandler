# m3uHandler

## Proprietary Notice

Copyright (c) 2026 mooresolutions. All rights reserved.

This project is proprietary. No part of this repository may be copied, modified, published,
distributed, sublicensed, and/or sold without prior written permission from mooresolutions.
See `LICENSE`.

---

CLI tool + GUI to convert an ApolloGroupTV/Starlite style M3U/M3U8 playlist into categorized
`.strm` files for media libraries.

## Output

Default output under `output/`:

- TV: `output/TV Shows/<Show (Year)>/Season 01/<Show (Year)> S01E01.strm`
- Movies: `output/Movies/<Year>/<Movie (Year)>.strm` (or flat with `--movies-flat`). The `tvg-type` attribute in the M3U file can be `movie` or `movies`.
- Live (optional): `output/Live/<Group Title>/<Channel Name>.strm`

Each `.strm` file contains the stream URL on a single line.

## Install

Cross-platform (Node.js + npm required):

```bash
npm run install-deps
```

Windows bootstrap (best-effort, uses winget if needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\\windows\\bootstrap.ps1
```

Linux bootstrap (best-effort, installs Node.js/npm via your package manager if needed):

```bash
bash scripts/linux/bootstrap.sh
```

Fetch timeout:

- `FETCH_TIMEOUT_MS` (default: `30000`) controls HTTP fetch timeout for daemon/GUI URL fetches.

## CLI

```bash
node src/index.js --help
node src/index.js -i <playlist.m3u8> [-o <outDir>]
```

Common flags:

- `-i, --input <file>`: Input playlist (M3U/M3U8).
- `-o, --out <dir>`: Output directory (default: `output/`).
- `--include-live`: Also generate Live `.strm` files under `output/Live/`.
- `--overwrite`: Overwrite existing `.strm` files.
- `--dry-run`: Print what would be generated without writing files.

## GUI

Start (localhost):

```bash
GUI_SESSION_SECRET="$(openssl rand -hex 32)" npm run gui
```

Windows PowerShell:

```powershell
$env:GUI_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
npm run gui
```

LAN (bind all interfaces):

```bash
GUI_SESSION_SECRET="$(openssl rand -hex 32)" GUI_HOST=0.0.0.0 npm run gui
```

Windows PowerShell (Admin may be required for firewall rule):

```powershell
$env:GUI_SESSION_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
$env:GUI_HOST = "0.0.0.0"
npm run gui
```

Open:

- <http://127.0.0.1:5177> (local)
- <http://your-lan-ip:5177> (LAN)

## Daemon (auto-update from URL)

Run with URL:

```bash
npm run daemon -- --url "https://example.com/playlist.m3u8" -o ./output
```

Or save config (keeps URL out of shell history/GUI after first save):

- `~/.config/m3uHandler/config.json`

```bash
npm run config -- init --url "https://example.com/playlist.m3u8" --out ./output --interval-hours 24
npm run daemon -- --use-config
```

Useful options:

```bash
npm run daemon -- --url "https://example.com/playlist.m3u8" --once
npm run daemon -- --url "https://example.com/playlist.m3u8" --interval-hours 6
npm run daemon -- --url "https://example.com/playlist.m3u8" --no-delete-missing
```

Notes:

- TV paging supported for `.../tvshows` (auto tries `/1..N` until 404, cap=50).
- Ignored entries are logged to `output/.logs/*-ignored.ndjson`.
- URL is logged in redacted form (avoid sharing credentialed URLs).
