'use strict';

/**
 * Fetches one or more M3U pages from a provider that splits TV shows across /tvshows/<page>.
 *
 * - Pages are fetched starting at 1 and stop on first 404 (or once maxPages is reached).
 * - Returns a single concatenated playlist string.
 *
 * Note: uses global fetch if available, else undici.fetch (already a project dependency).
 */

const { fetchWithTimeout } = require('./fetch-util');

const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

async function fetchTextStrict(url) {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (res.status === 404) {
    const err = new Error('Not Found');
    err.code = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function fetchPagedM3U({ baseUrl, maxPages = 50 }) {
  const parts = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}${page}`;
    try {
      const text = await fetchTextStrict(url);
      parts.push(text);
    } catch (e) {
      if (e && (e.code === 404 || e.status === 404)) break;
      throw e;
    }
  }
  return parts.join('\n');
}

module.exports = { fetchPagedM3U };
