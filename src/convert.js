'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function ensureDirSync(dir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileSyncSafe(filePath, content, { overwrite, dryRun }) {
  if (dryRun) return { action: 'dry-run' };
  if (!overwrite && fs.existsSync(filePath)) return { action: 'skipped-exists' };
  fs.writeFileSync(filePath, content, 'utf8');
  return { action: 'written' };
}

function sanitizeSegment(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function parseShowTitleAndEpisode(displayName, fallbackGroupTitle) {
  const episodeMatch = displayName.match(/\bS(\d{1,2})\s*E(\d{1,2})\b/i);
  // Also accept "S01 E101" (space-separated) which some providers use
  const episodeMatch2 = episodeMatch ? null : displayName.match(/\bS(\d{1,2})\s+E(\d{1,3})\b/i);
  const m = episodeMatch || episodeMatch2;
  const season = m ? String(parseInt(m[1], 10)).padStart(2, '0') : null;
  const episode = m ? String(parseInt(m[2], 10)).padStart(2, '0') : null;

  const baseFromGroup = fallbackGroupTitle && fallbackGroupTitle.match(/\(\d{4}\)\s*$/) ? fallbackGroupTitle : null;

  let showBase = baseFromGroup;
  if (!showBase) showBase = displayName.replace(/\bS\d{1,2}\s*E\d{1,2}\b/i, '').trim();

  const kodiEpisodeTag = season && episode ? `S${season}E${episode}` : null;

  return { showBase, season, episode, kodiEpisodeTag };
}

function decideOutputForEntry({ attrs, displayName }, { includeLive, moviesByYear, defaultType = null }) {
  const type = (attrs['tvg-type'] || '').toLowerCase() || (defaultType || '').toLowerCase();
  const groupTitle = attrs['group-title'] || 'Unknown';

  if (type === 'tvshows') {
    const { showBase, season, kodiEpisodeTag } = parseShowTitleAndEpisode(displayName, groupTitle);

    // If SxxEyy wasn't detected but tvg-name exists, still create a file:
    // - Put it in the show folder
    // - Use tvg-name as the filename to avoid collisions
    if (!kodiEpisodeTag && attrs['tvg-name']) {
      const showFolder = sanitizeSegment(showBase || groupTitle || 'Unknown Show');
      const fileName = sanitizeSegment(String(attrs['tvg-name'])) + '.strm';
      return path.join('TV Shows', showFolder, fileName);
    }

    if (!showBase || !season || !kodiEpisodeTag) return null;

    const showFolder = sanitizeSegment(showBase);
    const seasonFolder = `Season ${season}`;
    const fileName = sanitizeSegment(`${showBase} ${kodiEpisodeTag}`) + '.strm';

    return path.join('TV Shows', showFolder, seasonFolder, fileName);
  }

  if (type === 'movie' || type === 'movies') {
    const yearFromTitle = parseYearFromTitle(displayName);
    const yearFromGroup = (() => {
      const m = groupTitle.match(/(\d{4})\b/);
      return m ? m[1] : null;
    })();
    const year = yearFromTitle || yearFromGroup || 'Unknown';

    const movieName = sanitizeSegment(displayName) || sanitizeSegment(attrs['tvg-name'] || 'Unknown Movie');
    return moviesByYear ? path.join('Movies', year, `${movieName}.strm`) : path.join('Movies', `${movieName}.strm`);
  }

  if (type === 'live') {
    if (!includeLive) return null;
    const channel = sanitizeSegment(displayName) || sanitizeSegment(attrs['tvg-name'] || 'Unknown Channel');
    const group = sanitizeSegment(groupTitle);
    return path.join('Live', group || 'Live', `${channel}.strm`);
  }

  return null;
}

async function convertM3U({
  inputPath,
  outRoot,
  includeLive = false,
  overwrite = false,
  dryRun = false,
  moviesByYear = true,
  deleteMissing = false,
  ignoredLogPath = null,
  defaultType = null,
}) {
  if (!fs.existsSync(inputPath)) {
    const err = new Error(`Input file not found: ${inputPath}`);
    err.code = 'INPUT_NOT_FOUND';
    throw err;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let pendingExtinf = null;
  let stats = { written: 0, skipped: 0, ignored: 0, deleted: 0 };
  let lastWritten = null;

  let ignoredStream = null;
  if (ignoredLogPath && !dryRun) {
    ensureDirSync(path.dirname(ignoredLogPath), dryRun);
    ignoredStream = fs.createWriteStream(ignoredLogPath, { flags: 'a' });
    ignoredStream.write(`\n# ---- run ${new Date().toISOString()} input=${inputPath} ----\n`);
  }

  const expectedRelPaths = deleteMissing ? new Set() : null;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      pendingExtinf = line;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (!pendingExtinf) {
      stats.ignored++;
      continue;
    }

    const url = line;
    const { attrs, displayName } = parseExtinf(pendingExtinf);
    pendingExtinf = null;

    const rel = decideOutputForEntry({ attrs, displayName }, { includeLive, moviesByYear, defaultType });
    if (!rel) {
      stats.ignored++;
      if (ignoredStream) {
        const tvgType = attrs['tvg-type'] || '';
        const groupTitle = attrs['group-title'] || '';
        const tvgName = attrs['tvg-name'] || '';
        ignoredStream.write(
          JSON.stringify(
            {
              displayName,
              tvgType,
              groupTitle,
              tvgName,
              url,
              reason: 'No output path (unmatched type or missing SxxEyy for tvshows)',
            },
            null,
            0
          ) + '\n'
        );
      }
      continue;
    }

    const outPath = path.join(outRoot, rel);
    if (expectedRelPaths) expectedRelPaths.add(rel);
    const outDir = path.dirname(outPath);

    if (dryRun) {
      stats.written++;
      lastWritten = { outPath, url };
      continue;
    }

    ensureDirSync(outDir, dryRun);
    const res = writeFileSyncSafe(outPath, url + '\n', { overwrite, dryRun });

    if (res.action === 'written') {
      stats.written++;
      lastWritten = { outPath, url };
    } else if (res.action === 'skipped-exists') {
      stats.skipped++;
    }
  }

  if (ignoredStream) {
    await new Promise((r) => ignoredStream.end(r));
  }

  if (deleteMissing && expectedRelPaths) {
    // Delete .strm files under known roots that are not present in the current playlist.
    const roots = ['TV Shows', 'Movies', 'Live'].map((r) => path.join(outRoot, r));

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      await Promise.all(
        entries.map(async (ent) => {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            await walk(full);
            // Best-effort: remove empty dirs after deletions
            try {
              const remaining = await fs.promises.readdir(full);
              if (remaining.length === 0) await fs.promises.rm(full, { recursive: true, force: true });
            } catch {}
          } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.strm')) {
            const relFromOut = path.relative(outRoot, full);
            if (!expectedRelPaths.has(relFromOut)) {
              try {
                await fs.promises.unlink(full);
                stats.deleted++;
              } catch {}
            }
          }
        })
      );
    };

    for (const r of roots) await walk(r);
  }

  return { stats, lastWritten };
}

module.exports = { convertM3U };