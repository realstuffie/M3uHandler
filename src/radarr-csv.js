/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { makeLogger, installProcessHandlers, formatError } = require('./logger');

/**
 * Parse EXTINF line into attrs and displayName
 * Mirrors logic from src/convert.js to keep behavior consistent.
 */
function parseExtinf(line) {
  const commaIdx = line.lastIndexOf(',');
  const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
  const attrPart = commaIdx >= 0 ? line.slice(0, commaIdx) : line;

  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrPart)) !== null) {
    attrs[m[1]] = m[2];
  }

  return { attrs, displayName };
}

function parseYearFromTitle(title) {
  const m = title.match(/\((\d{4})\)\s*$/);
  return m ? m[1] : null;
}

/**
 * Very conservative guess of a movie title:
 * - strip any trailing year parens "(2024)"
 * - trim
 */
function parseMovieTitle(displayName) {
  return String(displayName || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  // RFC 4180: quote if contains comma/quote/newline; escape quotes by doubling them.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Generate Radarr-compatible CSV for "Import List -> TMDb List (CSV)".
 * Outputs columns: Title,Year,TmdbId (TmdbId blank if unknown)
 */
async function generateRadarrTmdbListCsv({ inputPath, outputPath, defaultYear = '' }) {
  if (!fs.existsSync(inputPath)) {
    const err = new Error(`Input file not found: ${inputPath}`);
    err.code = 'INPUT_NOT_FOUND';
    throw err;
  }

  const inputStream = fs.createReadStream(inputPath, { encoding: 'utf8' });

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  let pendingExtinf = null;
  const rows = [];
  // Header: Radarr expects Title + Year; TmdbId optional
  rows.push(['Title', 'Year', 'TmdbId']);

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        pendingExtinf = line;
        continue;
      }

      if (line.startsWith('#')) continue;

      // URL line (or other)
      if (!pendingExtinf) continue;

      const { attrs, displayName } = parseExtinf(pendingExtinf);
      pendingExtinf = null;

      const type = (attrs['tvg-type'] || '').toLowerCase();
      if (type && type !== 'movie' && type !== 'movies') continue;

      const year = parseYearFromTitle(displayName) || defaultYear || '';
      const title = parseMovieTitle(displayName) || attrs['tvg-name'] || '';

      if (!title) continue;

      // We don't have TMDb id in M3U; keep empty column for compatibility.
      rows.push([title, year, '']);
    }
  } finally {
    try {
      rl.close();
    } catch {}
    try {
      inputStream.destroy();
    } catch {}
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';

  if (!outputPath) return { csv, rows: rows.length - 1 };

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, csv, 'utf8');
  return { outputPath, rows: rows.length - 1 };
}

module.exports = { generateRadarrTmdbListCsv };

/**
 * CLI
 * Usage:
 *  node src/radarr-csv.js --input playlist.m3u --output output/radarr.csv [--default-year 2024]
 */
if (require.main === module) {
  const logger = makeLogger();
  installProcessHandlers(logger, { exitOnUncaughtException: true });

  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
  };

  const inputPath = getArg('--input') || getArg('-i');
  const outputPath = getArg('--output') || getArg('-o') || path.join('output', 'radarr.csv');
  const defaultYear = getArg('--default-year') || '';

  if (!inputPath) {
    logger.error(
      'Missing --input. Example: node src/radarr-csv.js --input playlist.m3u --output output/radarr.csv',
    );
    process.exitCode = 2;
  } else {
    logger.info(`Generating Radarr CSV... Log: ${logger.logPath}`);
    generateRadarrTmdbListCsv({ inputPath, outputPath, defaultYear })
      .then((res) => {
        logger.info(`Wrote Radarr CSV (${res.rows} movies): ${res.outputPath}`);
      })
      .catch((e) => {
        logger.error(`Failed to generate Radarr CSV: ${formatError(e)}`);
        process.exitCode = 1;
      });
  }
}
