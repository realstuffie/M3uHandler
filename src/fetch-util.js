'use strict';

/**
 * Shared fetch helper:
 * - Uses global fetch if available (Node 18+)
 * - Falls back to undici.fetch otherwise
 * - Supports timeout via AbortController
 */

function getFetchImpl() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  const undici = require('undici');
  if (typeof undici.fetch !== 'function') throw new Error('undici.fetch is not available');
  return undici.fetch;
}

async function fetchWithTimeout(url, init = {}, { timeoutMs = 30_000 } = {}) {
  const fetch = getFetchImpl();

  // If caller already provided a signal, don't override it.
  if (init && init.signal) {
    return await fetch(url, init);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchWithTimeout };