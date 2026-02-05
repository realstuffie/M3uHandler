/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');
const { convertM3U } = require('./convert');
const { fetchWithTimeout } = require('./fetch-util');
const { makeLogger, installProcessHandlers } = require('./logger');

const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}${body ? `\n${body.slice(0, 500)}` : ''}`);
  }
  return await res.text();
}

function parseArgs(argv) {
  const args = {
    url: null,
    out: 'output',
    includeLive: false,
    overwrite: true, // daemon default
    moviesByYear: true,
    moviesByFolder: false,
    deleteMissing: true, // per request
    intervalSeconds: 24 * 60 * 60,
    once: false,
    useConfig: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--use-config') args.useConfig = true;
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--include-live') args.includeLive = true;
    else if (a === '--no-delete-missing') args.deleteMissing = false;
    else if (a === '--movies-flat') args.moviesByYear = false;
    else if (a === '--movies-by-folder') args.moviesByFolder = true;
    else if (a === '--interval-seconds') args.intervalSeconds = Number(argv[++i]);
    else if (a === '--interval-hours') args.intervalSeconds = Number(argv[++i]) * 60 * 60;
    else if (a === '--once') args.once = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

function usage() {
  return `
m3uHandler daemon - periodically fetch an M3U URL and generate .strm files

Usage:
  m3uhandler --url <m3u_url> [options]

Options:
      --url <url>              Playlist URL to fetch (omit if using --use-config)
      --use-config             Load URL + settings from plaintext config (~/.config/m3uHandler/config.json)
  -o, --out <dir>              Output directory (default: output, overridden by config)
      --include-live           Also write live .strm entries (overridden by config)
      --movies-flat            Put movies directly under Movies/ (no Movies/<Year>/) (overridden by config)
      --movies-by-folder       Put movies under Movies/<Movie Name>/<Movie Name>.strm (overridden by config)
      --no-delete-missing      Do not delete .strm files missing from latest playlist
      --interval-hours <n>     Poll interval in hours (default: 24, overridden by config)
      --interval-seconds <n>   Poll interval in seconds (overrides hours)
      --once                   Run one update and exit
  -h, --help                   Show help
`.trim();
}

function redactUrl(u) {
  try {
    const url = new URL(u);

    // Mask credentials
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }

    // Avoid leaking tokens/keys in query strings in logs.
    // Keep only a short allowlist of "harmless" keys; drop the rest.
    const allow = new Set(['type', 'profile', 'quality', 'format']);
    for (const k of Array.from(url.searchParams.keys())) {
      if (!allow.has(k.toLowerCase())) url.searchParams.set(k, '***');
    }

    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function sanitizeLogMessage(msg, secrets = []) {
  let s = String(msg ?? '');
  // Replace common URL credential patterns
  s = s.replace(/\/\/([^/:@]+):([^@]+)@/g, '//***:***@');
  // Replace any provided secret strings verbatim
  for (const secret of secrets) {
    if (!secret) continue;
    try {
      s = s.split(String(secret)).join('***');
    } catch {}
  }
  return s;
}

async function runOnce({ url, outRoot, includeLive, overwrite, moviesByYear, moviesByFolder, deleteMissing, defaultType = null }) {
  const tmp = path.join(os.tmpdir(), `m3uHandler-${Date.now()}-${Math.random().toString(16).slice(2)}.m3u8`);
  try {
    const text = await fetchText(url);
    await fs.promises.writeFile(tmp, text, 'utf8');

    const { stats } = await convertM3U({
      inputPath: tmp,
      outRoot,
      includeLive,
      overwrite,
      moviesByYear,
      moviesByFolder,
      deleteMissing,
      dryRun: false,
      defaultType,
    });

    return stats;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const logger = makeLogger();

  // Graceful shutdown handling (Node.js process signal best practice)
  // - Stop after current run completes
  // - Exit on second signal (force)
  let stopRequested = false;
  let signalCount = 0;
  const handleSignal = (sig) => {
    signalCount++;
    stopRequested = true;
    const msg = `[${new Date().toISOString()}] received ${sig} (${signalCount}) - ${
      signalCount >= 2 ? 'forcing exit' : 'will stop after current cycle'
    }`;
    logger.warn(msg);
    if (signalCount >= 2) process.exit(1);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  installProcessHandlers(logger, {
    // Daemon should attempt to stop cleanly rather than hard-exit on first crash.
    exitOnUncaughtException: false,
    onUnhandledRejection: () => {
      stopRequested = true;
    },
    onUncaughtException: () => {
      stopRequested = true;
    },
  });

  let cfg = null;
  if (args.useConfig) {
    const { loadConfig, CONFIG_PATH } = require('./plain-config');
    cfg = loadConfig();
    if (!cfg) {
      logger.error(`No config found at ${CONFIG_PATH}. Create one with: node src/config.js init --url \"...\"`);
      process.exit(1);
    }
  }

  const finalUrl = cfg?.url || args.url;
  const finalUrlTv = cfg?.urlTv || null;
  const finalUrlMovies = cfg?.urlMovies || null;

  if (args.help || (!finalUrl && !finalUrlTv && !finalUrlMovies)) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0) {
    throw new Error('Interval must be a positive number.');
  }

  const outRoot = path.resolve(cfg?.out || args.out);
  const includeLive = cfg?.includeLive ?? args.includeLive;
  const moviesByYear = cfg?.moviesFlat ? false : args.moviesByYear;
  const moviesByFolder = cfg?.moviesByFolder ?? args.moviesByFolder;
  const intervalSeconds = Number.isFinite(cfg?.intervalHours) ? cfg.intervalHours * 60 * 60 : args.intervalSeconds;

  const urlsToRun = [];
  if (finalUrl) urlsToRun.push({ label: 'playlist', url: finalUrl, defaultType: null });
  if (finalUrlTv) urlsToRun.push({ label: 'tv', url: finalUrlTv, defaultType: 'tvshows' });
  if (finalUrlMovies) urlsToRun.push({ label: 'movies', url: finalUrlMovies, defaultType: 'movies' });

  // Collect secrets from all URLs for log redaction
  const secrets = [];
  for (const uStr of urlsToRun.map((x) => x.url)) {
    try {
      const u = new URL(uStr);
      if (u.username) secrets.push(u.username);
      if (u.password) secrets.push(u.password);
    } catch {}
  }

  const safeUrl = urlsToRun.map((x) => `${x.label}=${redactUrl(x.url)}`).join(' ');

  logger.info(`m3uHandler daemon started
URL: ${safeUrl}
Output: ${outRoot}
Interval: ${intervalSeconds}s
Delete missing: ${args.deleteMissing}
Log: ${logger.logPath}`);

  do {
    const started = new Date();
    logger.info(`[${started.toISOString()}] updating...`);

    // Run sequentially to avoid heavy concurrent I/O (helps overall system responsiveness)
    // Only deleteMissing on the *final* run of the batch, otherwise the first run could delete
    // files that the second run will re-create.
    for (let i = 0; i < urlsToRun.length; i++) {
      const { label, url, defaultType } = urlsToRun[i];
      const isLast = i === urlsToRun.length - 1;
      try {
        const stats = await runOnce({
          url,
          outRoot,
          includeLive,
          overwrite: args.overwrite,
          moviesByYear,
          moviesByFolder,
          deleteMissing: args.deleteMissing && isLast,
          defaultType,
        });
        logger.info(
          `[${new Date().toISOString()}] ${label} done. written=${stats.written} skipped=${stats.skipped} ignored=${stats.ignored} deleted=${stats.deleted}`
        );
      } catch (e) {
        logger.error(
          `[${new Date().toISOString()}] ${label} failed: ${sanitizeLogMessage(String(e?.stack || e), secrets)}`
        );
      }
    }

    if (args.once || stopRequested) break;

    // Sleep in smaller chunks so shutdown signals are respected quickly.
    const sleepChunkMs = 1000;
    let remainingMs = intervalSeconds * 1000;
    while (remainingMs > 0 && !stopRequested) {
      const ms = Math.min(sleepChunkMs, remainingMs);
      await sleep(ms);
      remainingMs -= ms;
    }
  } while (!stopRequested);
}

main().catch((err) => {
  const logger = makeLogger();
  logger.error(err?.stack || String(err));
  process.exitCode = 1;
});
