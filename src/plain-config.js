'use strict';

const fs = require('fs');
const path = require('path');
const envPaths = require('env-paths');

const paths = typeof envPaths === 'function' ? envPaths('m3uHandler') : envPaths.default('m3uHandler');
const CONFIG_DIR = paths.config;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function saveConfig(configObj) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configObj, null, 2), { mode: 0o600 });
  return { configPath: CONFIG_PATH };
}

function loadConfig() {
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  saveConfig,
  loadConfig,
  safeUrlHost,
};