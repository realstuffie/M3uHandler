'use strict';

/**
 * Fetches one or more M3U pages from a provider that splits TV shows across /tvshows/<page>.
 *
 * - Pages are fetched starting at 1 and stop on first 404 (or once maxPages is reached).
 * - Returns a single concatenated playlist string.
 *
 * Note: uses global fetch if available, else undici.fetch (already a project dependency).
 */

async function getFetch() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  const undici = require('undici');
  if (typeof undici.fetch !== 'function') throw new Error('undici.fetch is not available');
  return undici.fetch;
}

async function fetchTextStrict(url) {
  const fetch = await getFetch();
  const res = await fetch(url, { redirect: 'follow' });
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