/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = process.env.M3UHANDLER_LOG_PATH || path.join('output', 'm3uHandler.log');

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toLine(level, message) {
  const ts = new Date().toISOString();
  return `[${ts}] ${level.toUpperCase()}: ${message}\n`;
}

function formatError(err) {
  if (!err) return '';
  if (err instanceof Error) return err.stack || err.message || String(err);
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function appendLine(logPath, line) {
  ensureDirSync(path.dirname(logPath));
  fs.appendFileSync(logPath, line, 'utf8');
}

function makeLogger({ logPath = DEFAULT_LOG_PATH } = {}) {
  const write = (level, msg) => {
    const message = msg instanceof Error ? formatError(msg) : String(msg ?? '');
    const line = toLine(level, message);

    // Always mirror to stderr for warnings/errors; stdout for info/debug
    if (level === 'error' || level === 'warn') {
      // eslint-disable-next-line no-console
      console.error(line.trimEnd());
    } else {
      // eslint-disable-next-line no-console
      console.log(line.trimEnd());
    }

    try {
      appendLine(logPath, line);
    } catch (e) {
      // If file logging fails, still keep console output.
      // eslint-disable-next-line no-console
      console.error(`[${new Date().toISOString()}] LOGGER ERROR: ${formatError(e)}`);
    }
  };

  return {
    logPath,
    debug: (msg) => write('debug', msg),
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    errorWithContext: (context, err) => write('error', `${context}: ${formatError(err)}`),
  };
}

/**
 * Installs global process error handlers that log to the given logger.
 * Returns a cleanup function.
 */
function installProcessHandlers(
  logger,
  { exitOnUncaughtException = false, onUnhandledRejection, onUncaughtException, exitCodeOnUncaughtException = 1 } = {}
) {
  const _onUnhandledRejection = (reason, promise) => {
    logger.errorWithContext('unhandledRejection', reason);
    if (typeof onUnhandledRejection === 'function') onUnhandledRejection(reason, promise);
  };

  const _onUncaughtException = (err, origin) => {
    logger.errorWithContext('uncaughtException', err);

    // Node.js docs: adding an 'uncaughtException' handler overrides the default
    // behavior to print a stack trace and exit(1). If we don't explicitly set an
    // exit code, the process may exit with 0 when a handler is present.
    if (!exitOnUncaughtException) process.exitCode = exitCodeOnUncaughtException;

    if (typeof onUncaughtException === 'function') onUncaughtException(err, origin);
    if (exitOnUncaughtException) process.exit(exitCodeOnUncaughtException);
  };

  process.on('unhandledRejection', _onUnhandledRejection);
  process.on('uncaughtException', _onUncaughtException);

  return () => {
    process.off('unhandledRejection', _onUnhandledRejection);
    process.off('uncaughtException', _onUncaughtException);
  };
}

module.exports = {
  DEFAULT_LOG_PATH,
  makeLogger,
  installProcessHandlers,
  formatError,
};