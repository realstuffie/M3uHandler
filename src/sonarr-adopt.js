/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { makeLogger, installProcessHandlers, formatError } = require('./logger');

/**
 * Minimal Sonarr bulk-adopt tool:
 * - Scans an existing TV library folder (folders named "Title (Year)" or "Title")
 * - Looks up TVDB via Sonarr lookup API
 * - Adds series via Sonarr API in batches (default: 1000)
 *
 * Designed to bypass the Sonarr GUI library import for very large collections.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapConcurrent(items, concurrency, mapper) {
  const limit = Math.max(1, Number(concurrency || 1));
  const results = new Array(items.length);
  let nextIdx = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseTitleYearFromFolderName(folderName) {
  // Typical with year: "Breaking Bad (2008)"
  const mWithYear = folderName.match(/^(.*)\s+\((\d{4})\)\s*$/);
  if (mWithYear) {
    const title = mWithYear[1].trim();
    const year = Number(mWithYear[2]);
    if (title && year) return { title, year };
  }

  // Fallback: no year in folder name e.g. "Firefly"
  const title = folderName.trim();
  if (title) return { title, year: null };

  return null;
}

function readJsonFileSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function requestJson({ baseUrl, apiKey, method, pathname, query, body, timeoutMs = 120000 }) {
  const u = new URL(baseUrl);
  u.pathname = pathname;
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      u.searchParams.set(k, String(v));
    }
  }

  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;

  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');

  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
    },
    timeout: timeoutMs,
  };

  if (payload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = payload.length;
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) {
          const err = new Error(`Sonarr API ${method} ${pathname} failed: ${res.statusCode} ${res.statusMessage}\n${buf}`);
          err.statusCode = res.statusCode;
          err.body = buf;
          return reject(err);
        }

        if (!buf) return resolve(null);
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve(buf);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function withRetries(fn, { retries = 5, baseDelayMs = 500, maxDelayMs = 10000, logger } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const status = e && e.statusCode;
      const retryable =
        status === 429 || (status >= 500 && status <= 599) || (e && String(e.message || '').toLowerCase().includes('timeout'));
      if (!retryable || attempt > retries) throw e;

      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const warn = logger ? logger.warn.bind(logger) : console.warn.bind(console);
      warn(`Retrying after error (attempt ${attempt}/${retries}, delay ${delay}ms): ${e.message}`);
      await sleep(delay);
    }
  }
}

async function listExistingSeries({ baseUrl, apiKey }) {
  return (await requestJson({ baseUrl, apiKey, method: 'GET', pathname: '/api/v3/series' })) || [];
}

function indexSeriesByPath(series) {
  const byPath = new Map();
  for (const s of series || []) {
    if (s && s.path) byPath.set(s.path, s);
  }
  return byPath;
}

function indexSeriesByTvdbId(series) {
  const byTvdbId = new Map();
  for (const s of series || []) {
    const tvdbId = s && (s.tvdbId ?? s.tvdbID ?? s.TvdbId);
    if (tvdbId != null) byTvdbId.set(Number(tvdbId), s);
  }
  return byTvdbId;
}

async function lookupSeries({ baseUrl, apiKey, title, year, logger }) {
  const term = year ? `${title} ${year}` : title;
  const results = await withRetries(
    () => requestJson({ baseUrl, apiKey, method: 'GET', pathname: '/api/v3/series/lookup', query: { term } }),
    { logger }
  );

  // Prefer exact year match if present.
  const exact = (results || []).find((r) => r && year && Number(r.year) === Number(year));
  return exact || (results && results[0]) || null;
}

function parseSonarrErrorBody(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function isSeriesAlreadyExistsError(err) {
  if (!err || err.statusCode !== 400) return false;

  const parsed = parseSonarrErrorBody(err.body);
  if (!Array.isArray(parsed)) return false;

  return parsed.some((e) => e && (e.errorCode === 'SeriesExistsValidator' || /already been added/i.test(e.errorMessage || '')));
}

async function addSeries({ baseUrl, apiKey, series, logger }) {
  return withRetries(() => requestJson({ baseUrl, apiKey, method: 'POST', pathname: '/api/v3/series', body: series }), { logger });
}

async function adoptLibrary({
  baseUrl,
  apiKey,
  libraryPath,
  rootFolderPath,
  batchSize = 1000,
  monitored = true,
  searchForMissingEpisodes = false,
  seasonFolder = true,
  seriesType = 'standard',
  qualityProfileId = 1,
  languageProfileId = 1,
  dryRun = false,
  lookupConcurrency = 10,
  addConcurrency = 2,
  statePath = path.join('output', 'sonarr-adopt-state.json'),
  cachePath = path.join('output', 'sonarr-lookup-cache.json'),
}) {
  const logger = makeLogger();
  installProcessHandlers(logger, { exitOnUncaughtException: false });

  const absLibraryPath = path.resolve(libraryPath);

  const state = readJsonFileSafe(statePath, { addedPaths: {} });
  const lookupCache = readJsonFileSafe(cachePath, {});

  const logStage = (msg) => {
    logger.info(`\n==> ${msg}`);
  };

  const logProgress = ({ label, current, total, every = 250 }) => {
    if (!total) return;
    if (current === 0) return;
    if (current % every !== 0 && current !== total) return;
    const pct = ((current / total) * 100).toFixed(1);
    logger.info(`${label}: ${current}/${total} (${pct}%)`);
  };

  logStage('Configuration');
  logger.info(`Library path: ${absLibraryPath}`);
  logger.info(`Sonarr rootFolderPath: ${rootFolderPath}`);
  logger.info(
    `Batch size: ${batchSize} | monitored=${monitored} | searchForMissingEpisodes=${searchForMissingEpisodes} | seasonFolder=${seasonFolder} | seriesType=${seriesType} | dryRun=${dryRun} | lookupConcurrency=${lookupConcurrency} | addConcurrency=${addConcurrency}`
  );
  logger.info(`State: ${statePath}`);
  logger.info(`Lookup cache: ${cachePath}`);
  logger.info(`Log: ${logger.logPath}`);

  logStage(dryRun ? 'Dry-run mode: will not call Sonarr APIs (scan only)' : 'Loading existing series from Sonarr');
  const existingSeries = dryRun ? [] : await listExistingSeries({ baseUrl, apiKey });
  const existingByPath = indexSeriesByPath(existingSeries);
  const existingByTvdbId = indexSeriesByTvdbId(existingSeries);

  if (!dryRun) {
    logger.info(`Loaded ${existingSeries.length} existing series from Sonarr.`);
  }

  logStage('Scanning library root for "Title (Year)" or "Title" folders');
  const entries = await fs.promises.readdir(absLibraryPath, { withFileTypes: true });

  const candidates = [];
  let scannedDirs = 0;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    scannedDirs++;

    const info = parseTitleYearFromFolderName(ent.name);
    if (!info) continue;

    const seriesDirPath = path.join(absLibraryPath, ent.name);

    // Skip if already added in previous run or already exists in Sonarr
    if (state.addedPaths && state.addedPaths[seriesDirPath]) continue;
    if (existingByPath.has(seriesDirPath)) continue;

    candidates.push({ title: info.title, year: info.year, folderName: ent.name, path: seriesDirPath });

    logProgress({ label: 'Scan progress (directories)', current: scannedDirs, total: entries.length, every: 500 });
  }

  logger.info(`Found ${candidates.length} candidate series folders to add.`);

  logStage(
    dryRun
      ? 'Preparing series payloads (cache only; dry-run does not call Sonarr lookup)'
      : `Preparing series payloads (TVDB lookup via Sonarr, concurrency=${lookupConcurrency})`
  );

  let lookedUp = 0;
  let skippedLookup = 0;
  let processedCandidates = 0;

  const missing = [];
  for (const c of candidates) {
    const cacheKey = c.year ? `${c.title} (${c.year})` : c.title;
    const existing = lookupCache[cacheKey];
    if (existing === undefined && !dryRun) {
      missing.push({ c, cacheKey });
    } else {
      skippedLookup++;
    }
  }

  if (!dryRun && missing.length) {
    let done = 0;
    await mapConcurrent(missing, lookupConcurrency, async ({ c, cacheKey }) => {
      const lookup = await lookupSeries({ baseUrl, apiKey, title: c.title, year: c.year, logger });
      lookupCache[cacheKey] = lookup
        ? { tvdbId: lookup.tvdbId, title: lookup.title, year: lookup.year }
        : null;

      done++;
      lookedUp++;
      if (done % 200 === 0) writeJsonAtomic(cachePath, lookupCache);
      logProgress({ label: 'Lookup progress (missing)', current: done, total: missing.length, every: 200 });

      return null;
    });
  }

  // Build payloads
  const toAdd = [];
  for (const c of candidates) {
    processedCandidates++;

    const cacheKey = c.year ? `${c.title} (${c.year})` : c.title;
    const lookup = lookupCache[cacheKey];

    const tvdbId = lookup && lookup.tvdbId ? lookup.tvdbId : null;
    if (!tvdbId) {
      logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
      continue;
    }

    // Skip if TVDB ID already exists in Sonarr (avoids 400 SeriesExistsValidator)
    if (!dryRun && existingByTvdbId.has(Number(tvdbId))) {
      logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
      continue;
    }

    toAdd.push({
      tvdbId,
      title: lookup.title || c.title,
      year: lookup.year || c.year,
      qualityProfileId,
      languageProfileId,
      rootFolderPath,
      path: c.path,
      monitored,
      seasonFolder,
      seriesType,
      addOptions: {
        searchForMissingEpisodes,
        monitor: monitored ? 'all' : 'none',
      },
    });

    logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
  }

  writeJsonAtomic(cachePath, lookupCache);

  logger.info(`Prepared ${toAdd.length} series to add (lookups: ${lookedUp}, cache hits: ${skippedLookup}).`);

  const batches = chunk(toAdd, batchSize);

  let addedCount = 0;

  logStage(
    dryRun
      ? 'Dry-run: would add series (no API calls)'
      : `Adding series to Sonarr (individual POSTs, concurrency=${addConcurrency})`
  );

  if (dryRun) {
    for (let i = 0; i < batches.length; i++) {
      // eslint-disable-next-line no-console
      console.log(`Adding batch ${i + 1}/${batches.length} (${batches[i].length} series)...`);
      addedCount += batches[i].length;
    }
  } else {
    let doneShows = 0;
    let skippedExists = 0;
    let failed = 0;

    await mapConcurrent(toAdd, addConcurrency, async (series, idx) => {
      try {
        const res = await addSeries({ baseUrl, apiKey, series, logger });

        if (res && res.tvdbId != null) existingByTvdbId.set(Number(res.tvdbId), res);
        if (res && res.path) existingByPath.set(res.path, res);

        if (res && res.path) {
          state.addedPaths[res.path] = true;
          writeJsonAtomic(statePath, state);
        } else if (series && series.path) {
          state.addedPaths[series.path] = true;
          writeJsonAtomic(statePath, state);
        }
      } catch (e) {
        if (isSeriesAlreadyExistsError(e)) {
          skippedExists++;
          if (series && series.path) {
            state.addedPaths[series.path] = true;
            writeJsonAtomic(statePath, state);
          }
        } else {
          failed++;
          logger.error(
            `Failed to add: ${series && series.path ? series.path : '(unknown path)'} :: ${formatError(e)}`
          );
        }
      } finally {
        doneShows++;
        addedCount++;
        logProgress({ label: 'Add progress (series)', current: doneShows, total: toAdd.length, every: 100 });
        if (doneShows % 500 === 0 || doneShows === toAdd.length) {
          logger.info(`Added so far: ${doneShows}/${toAdd.length} (skippedExists=${skippedExists}, failed=${failed})`);
        }
      }

      return { idx, path: series.path };
    });
  }

  return { candidates: candidates.length, prepared: toAdd.length, added: addedCount };
}

module.exports = { adoptLibrary };

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`sonarr-adopt

Usage:
  SONARR_URL="http://127.0.0.1:8989" SONARR_API_KEY="..." \\
    node src/sonarr-adopt.js --location "/mnt/share/Emby/TV/Shows"

Required:
  --location <path>        Library root folder. Used as:
                           - scan location (same as --library-path)
                           - Sonarr rootFolderPath (same as --root-folder)
                           Must contain folders like "Title (Year)" or "Title".

Optional:
  --library-path <path>        Override scan location (advanced)
  --root-folder <path>         Override Sonarr rootFolderPath (advanced; must match a configured root folder in Sonarr)
  --batch-size <n>             Default 1000
  --monitored <true|false>     Default true
  --search                     If set, Sonarr will search for missing episodes after add (default: off)
  --season-folder <true|false> Default true (organise episodes into per-season sub-folders)
  --series-type <type>         standard | daily | anime  (default: standard)
  --quality-profile <n>        Quality profile ID (default: 1)
  --language-profile <n>       Language profile ID (default: 1)
  --dry-run                    Do not call Sonarr, just scan/prepare
  --lookup-concurrency <n>     Default 10 (parallel Sonarr lookup calls)
  --add-concurrency <n>        Default 2 (parallel POSTs to Sonarr)
  --state <path>               Default output/sonarr-adopt-state.json
  --cache <path>               Default output/sonarr-lookup-cache.json
`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const hasFlag = (name) => args.includes(name);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
  };

  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    process.exit(0);
  }

  const baseUrl = process.env.SONARR_URL;
  const apiKey = process.env.SONARR_API_KEY;

  const location = getArg('--location');

  const libraryPath = location || getArg('--library-path') || getArg('--library') || getArg('-l');
  const rootFolderPath = location || getArg('--root-folder') || getArg('--root') || getArg('-r');

  const batchSize = Number(getArg('--batch-size') || 1000);
  const monitored = (getArg('--monitored') || 'true').toLowerCase() !== 'false';
  const searchForMissingEpisodes = hasFlag('--search');
  const seasonFolder = (getArg('--season-folder') || 'true').toLowerCase() !== 'false';
  const seriesType = getArg('--series-type') || 'standard';
  const qualityProfileId = Number(getArg('--quality-profile') || 1);
  const languageProfileId = Number(getArg('--language-profile') || 1);
  const dryRun = hasFlag('--dry-run');

  const statePath = getArg('--state') || path.join('output', 'sonarr-adopt-state.json');
  const cachePath = getArg('--cache') || path.join('output', 'sonarr-lookup-cache.json');

  const lookupConcurrency = Number(getArg('--lookup-concurrency') || 10);
  const addConcurrency = Number(getArg('--add-concurrency') || 2);

  if (!baseUrl || !apiKey) {
    // eslint-disable-next-line no-console
    console.error('Missing env vars: SONARR_URL and/or SONARR_API_KEY');
    process.exitCode = 2;
  } else if (!libraryPath || !rootFolderPath) {
    // eslint-disable-next-line no-console
    console.error('Missing required args: --library-path and/or --root-folder');
    printHelp();
    process.exitCode = 2;
  } else {
    adoptLibrary({
      baseUrl,
      apiKey,
      libraryPath,
      rootFolderPath,
      batchSize,
      monitored,
      searchForMissingEpisodes,
      seasonFolder,
      seriesType,
      qualityProfileId,
      languageProfileId,
      dryRun,
      lookupConcurrency,
      addConcurrency,
      statePath,
      cachePath,
    })
      .then((res) => {
        const logger = makeLogger();
        logger.info(`Done. candidates=${res.candidates} prepared=${res.prepared} added=${res.added}`);
      })
      .catch((e) => {
        const logger = makeLogger();
        logger.error(formatError(e));
        process.exitCode = 1;
      });
  }
}
