/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/**
 * Minimal Radarr bulk-adopt tool:
 * - Scans an existing movie library folder (folders named "Title (Year)")
 * - Looks up TMDb via Radarr lookup API
 * - Adds movies via Radarr API in batches (default: 1000)
 *
 * Designed to bypass the Radarr GUI library import for very large collections.
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
  // Typical: "American Beauty (1999)"
  const m = folderName.match(/^(.*)\s+\((\d{4})\)\s*$/);
  if (!m) return null;
  const title = m[1].trim();
  const year = Number(m[2]);
  if (!title || !year) return null;
  return { title, year };
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
          const err = new Error(`Radarr API ${method} ${pathname} failed: ${res.statusCode} ${res.statusMessage}\n${buf}`);
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

async function withRetries(fn, { retries = 5, baseDelayMs = 500, maxDelayMs = 10000 } = {}) {
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
      // eslint-disable-next-line no-console
      console.warn(`Retrying after error (attempt ${attempt}/${retries}, delay ${delay}ms): ${e.message}`);
      await sleep(delay);
    }
  }
}

async function listExistingMovies({ baseUrl, apiKey }) {
  // This can be big; but Radarr handles it.
  return (await requestJson({ baseUrl, apiKey, method: 'GET', pathname: '/api/v3/movie' })) || [];
}

function indexMoviesByPath(movies) {
  const byPath = new Map();
  for (const m of movies || []) {
    if (m && m.path) byPath.set(m.path, m);
  }
  return byPath;
}

function indexMoviesByTmdbId(movies) {
  const byTmdbId = new Map();
  for (const m of movies || []) {
    const tmdbId = m && (m.tmdbId ?? m.tmdbID ?? m.TmdbId);
    if (tmdbId != null) byTmdbId.set(Number(tmdbId), m);
  }
  return byTmdbId;
}

async function lookupMovie({ baseUrl, apiKey, title, year }) {
  const term = year ? `${title} ${year}` : title;
  const results = await withRetries(
    () => requestJson({ baseUrl, apiKey, method: 'GET', pathname: '/api/v3/movie/lookup', query: { term } }),
    {}
  );

  // Prefer exact year match if present.
  const exact = (results || []).find((r) => r && Number(r.year) === Number(year));
  return exact || (results && results[0]) || null;
}

function parseRadarrErrorBody(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function isMovieAlreadyExistsError(err) {
  if (!err || err.statusCode !== 400) return false;

  const parsed = parseRadarrErrorBody(err.body);
  if (!Array.isArray(parsed)) return false;

  return parsed.some((e) => e && (e.errorCode === 'MovieExistsValidator' || /already been added/i.test(e.errorMessage || '')));
}

async function addMovie({ baseUrl, apiKey, movie }) {
  // Radarr expects a single MovieResource per POST to /api/v3/movie.
  // (Bulk add uses /api/v3/movie/import on some versions; to keep this tool compatible,
  // we POST individual movies with bounded concurrency at a higher level.)
  return withRetries(() => requestJson({ baseUrl, apiKey, method: 'POST', pathname: '/api/v3/movie', body: movie }), {});
}

async function adoptLibrary({
  baseUrl,
  apiKey,
  libraryPath,
  rootFolderPath,
  batchSize = 1000,
  monitored = true,
  searchForMovie = false,
  dryRun = false,
  lookupConcurrency = 10,
  addConcurrency = 2,
  statePath = path.join('output', 'radarr-adopt-state.json'),
  cachePath = path.join('output', 'radarr-lookup-cache.json'),
}) {
  const absLibraryPath = path.resolve(libraryPath);

  const state = readJsonFileSafe(statePath, { addedPaths: {} });
  const lookupCache = readJsonFileSafe(cachePath, {});

  const logStage = (msg) => {
    // eslint-disable-next-line no-console
    console.log(`\n==> ${msg}`);
  };

  const logProgress = ({ label, current, total, every = 250 }) => {
    if (!total) return;
    if (current === 0) return;
    if (current % every !== 0 && current !== total) return;
    const pct = ((current / total) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`${label}: ${current}/${total} (${pct}%)`);
  };

  logStage('Configuration');
  // eslint-disable-next-line no-console
  console.log(`Library path: ${absLibraryPath}`);
  // eslint-disable-next-line no-console
  console.log(`Radarr rootFolderPath: ${rootFolderPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `Batch size: ${batchSize} | monitored=${monitored} | searchForMovie=${searchForMovie} | dryRun=${dryRun} | lookupConcurrency=${lookupConcurrency} | addConcurrency=${addConcurrency}`
  );
  // eslint-disable-next-line no-console
  console.log(`State: ${statePath}`);
  // eslint-disable-next-line no-console
  console.log(`Lookup cache: ${cachePath}`);

  logStage(dryRun ? 'Dry-run mode: will not call Radarr APIs (scan only)' : 'Loading existing movies from Radarr');
  const existingMovies = dryRun ? [] : await listExistingMovies({ baseUrl, apiKey });
  const existingByPath = indexMoviesByPath(existingMovies);
  const existingByTmdbId = indexMoviesByTmdbId(existingMovies);

  if (!dryRun) {
    // eslint-disable-next-line no-console
    console.log(`Loaded ${existingMovies.length} existing movies from Radarr.`);
  }

  logStage('Scanning library root for "Title (Year)" folders');
  const entries = await fs.promises.readdir(absLibraryPath, { withFileTypes: true });

  const candidates = [];
  let scannedDirs = 0;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    scannedDirs++;

    const info = parseTitleYearFromFolderName(ent.name);
    if (!info) continue;

    const movieDirPath = path.join(absLibraryPath, ent.name);

    // Skip if already added in previous run or already exists in Radarr
    if (state.addedPaths && state.addedPaths[movieDirPath]) continue;
    if (existingByPath.has(movieDirPath)) continue;

    candidates.push({ title: info.title, year: info.year, folderName: ent.name, path: movieDirPath });

    logProgress({ label: 'Scan progress (directories)', current: scannedDirs, total: entries.length, every: 500 });
  }

  // eslint-disable-next-line no-console
  console.log(`Found ${candidates.length} candidate movie folders to add.`);

  logStage(
    dryRun
      ? 'Preparing movie payloads (cache only; dry-run does not call Radarr lookup)'
      : `Preparing movie payloads (TMDb lookup via Radarr, concurrency=${lookupConcurrency})`
  );

  let lookedUp = 0;
  let skippedLookup = 0;
  let processedCandidates = 0;

  // Pre-read which keys are missing so we can do lookups in parallel
  const missing = [];
  for (const c of candidates) {
    const cacheKey = `${c.title} (${c.year})`;
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
      const lookup = await lookupMovie({ baseUrl, apiKey, title: c.title, year: c.year });
      lookupCache[cacheKey] = lookup ? { tmdbId: lookup.tmdbId, title: lookup.title, year: lookup.year } : null;

      done++;
      lookedUp++;
      if (done % 200 === 0) writeJsonAtomic(cachePath, lookupCache);
      logProgress({ label: 'Lookup progress (missing)', current: done, total: missing.length, every: 200 });

      return null;
    });
  }

  // Now build payloads (fast, local)
  const toAdd = [];
  for (const c of candidates) {
    processedCandidates++;

    const cacheKey = `${c.title} (${c.year})`;
    const lookup = lookupCache[cacheKey];

    const tmdbId = lookup && lookup.tmdbId ? lookup.tmdbId : null;
    if (!tmdbId) {
      logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
      continue;
    }

    // Skip if TMDb already exists in Radarr (avoids 400 MovieExistsValidator)
    if (!dryRun && existingByTmdbId.has(Number(tmdbId))) {
      logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
      continue;
    }

    toAdd.push({
      tmdbId,
      title: lookup.title || c.title,
      year: lookup.year || c.year,
      qualityProfileId: 1,
      rootFolderPath,
      path: c.path,
      monitored,
      addOptions: {
        searchForMovie,
      },
    });

    logProgress({ label: 'Prepare progress (candidates)', current: processedCandidates, total: candidates.length, every: 250 });
  }

  writeJsonAtomic(cachePath, lookupCache);

  // eslint-disable-next-line no-console
  console.log(`Prepared ${toAdd.length} movies to add (lookups: ${lookedUp}, cache hits: ${skippedLookup}).`);

  const batches = chunk(toAdd, batchSize);

  let addedCount = 0;

  logStage(
    dryRun
      ? 'Dry-run: would add movies (no API calls)'
      : `Adding movies to Radarr (individual POSTs, concurrency=${addConcurrency})`
  );

  if (dryRun) {
    // Preserve the existing "batch" preview output in dry-run
    for (let i = 0; i < batches.length; i++) {
      // eslint-disable-next-line no-console
      console.log(`Adding batch ${i + 1}/${batches.length} (${batches[i].length} movies)...`);
      addedCount += batches[i].length;
    }
  } else {
    let doneMovies = 0;

    let skippedExists = 0;
    let failed = 0;

    await mapConcurrent(toAdd, addConcurrency, async (movie, idx) => {
      try {
        const res = await addMovie({ baseUrl, apiKey, movie });

        // Update indexes to reduce chances of duplicates during the same run
        if (res && res.tmdbId != null) existingByTmdbId.set(Number(res.tmdbId), res);
        if (res && res.path) existingByPath.set(res.path, res);

        // Mark path as added to allow resume
        if (res && res.path) {
          state.addedPaths[res.path] = true;
          writeJsonAtomic(statePath, state);
        } else if (movie && movie.path) {
          // Fallback: still checkpoint the intended path if Radarr doesn't echo it
          state.addedPaths[movie.path] = true;
          writeJsonAtomic(statePath, state);
        }
      } catch (e) {
        if (isMovieAlreadyExistsError(e)) {
          skippedExists++;
          // Still mark as added so we don't keep retrying this folder on resume
          if (movie && movie.path) {
            state.addedPaths[movie.path] = true;
            writeJsonAtomic(statePath, state);
          }
        } else {
          failed++;
          // eslint-disable-next-line no-console
          console.error(`Failed to add: ${movie && movie.path ? movie.path : '(unknown path)'} :: ${e.message}`);
        }
      } finally {
        doneMovies++;
        addedCount++;
        logProgress({ label: 'Add progress (movies)', current: doneMovies, total: toAdd.length, every: 100 });
        if (doneMovies % 500 === 0 || doneMovies === toAdd.length) {
          // eslint-disable-next-line no-console
          console.log(`Added so far: ${doneMovies}/${toAdd.length} (skippedExists=${skippedExists}, failed=${failed})`);
        }
      }

      return { idx, path: movie.path };
    });
  }

  return { candidates: candidates.length, prepared: toAdd.length, added: addedCount };
}

module.exports = { adoptLibrary };

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`radarr-adopt

Usage:
  RADARR_URL="http://127.0.0.1:7878" RADARR_API_KEY="..." \\
    node src/radarr-adopt.js --library-path "/mnt/share/Emby/Movies/Movies" --root-folder "/mnt/share/Emby/Movies/Movies"

Required:
  --library-path <path>    Path containing movie folders like "Title (Year)"
  --root-folder <path>     Radarr rootFolderPath (must match a configured root folder in Radarr)

Optional:
  --batch-size <n>             Default 1000
  --monitored <true|false>     Default true
  --search                     If set, Radarr will search for missing movies after add (default: off)
  --dry-run                    Do not call Radarr, just scan/prepare
  --lookup-concurrency <n>     Default 10 (parallel Radarr lookup calls)
  --add-concurrency <n>        Default 2 (parallel batch POSTs to Radarr)
  --state <path>               Default output/radarr-adopt-state.json
  --cache <path>               Default output/radarr-lookup-cache.json
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

  const baseUrl = process.env.RADARR_URL;
  const apiKey = process.env.RADARR_API_KEY;

  const libraryPath = getArg('--library-path') || getArg('--library') || getArg('-l');
  const rootFolderPath = getArg('--root-folder') || getArg('--root') || getArg('-r');

  const batchSize = Number(getArg('--batch-size') || 1000);
  const monitored = (getArg('--monitored') || 'true').toLowerCase() !== 'false';
  const searchForMovie = hasFlag('--search');
  const dryRun = hasFlag('--dry-run');

  const statePath = getArg('--state') || path.join('output', 'radarr-adopt-state.json');
  const cachePath = getArg('--cache') || path.join('output', 'radarr-lookup-cache.json');

  const lookupConcurrency = Number(getArg('--lookup-concurrency') || 10);
  const addConcurrency = Number(getArg('--add-concurrency') || 2);

  if (!baseUrl || !apiKey) {
    // eslint-disable-next-line no-console
    console.error('Missing env vars: RADARR_URL and/or RADARR_API_KEY');
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
      searchForMovie,
      dryRun,
      lookupConcurrency,
      addConcurrency,
      statePath,
      cachePath,
    })
      .then((res) => {
        // eslint-disable-next-line no-console
        console.log(`Done. candidates=${res.candidates} prepared=${res.prepared} added=${res.added}`);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error(e && e.stack ? e.stack : String(e));
        process.exitCode = 1;
      });
  }
}