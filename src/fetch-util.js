/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

/**
 * Shared fetch helper:
 * - Uses global fetch if available (Node 18+)
 * - Falls back to undici.fetch otherwise
 * - Supports timeout via AbortController
 */

function getFetchImpl() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('global fetch is not available; requires Node 18+');
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
