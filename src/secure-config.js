'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const envPaths = require('env-paths');

const paths = envPaths('m3uHandler');
const CONFIG_DIR = paths.config; // e.g. ~/.config/m3uHandler on Linux
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.enc.json');

const SERVICE_NAME = 'm3uHandler';
const ACCOUNT_NAME = 'master-key';

const BACKUP_DAYS = 3;

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

async function getKeytar() {
  // keytar is ESM-ish in some environments; dynamic import works from CJS in Node
  const mod = await import('keytar');
  return mod.default || mod;
}

async function readOrCreateMasterKey() {
  ensureDir();
  const keytar = await getKeytar();

  const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  if (existing) {
    return Buffer.from(existing, 'base64');
  }

  const masterKey = crypto.randomBytes(32);
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, masterKey.toString('base64'));
  return masterKey;
}

function hkdfDailyKey(masterKey, dateStr) {
  // dateStr: YYYY-MM-DD in local time (rolling daily)
  const salt = Buffer.from(`m3uHandler|salt|${dateStr}`, 'utf8');
  const info = Buffer.from('m3uHandler|config-key', 'utf8');
  return crypto.hkdfSync('sha256', masterKey, salt, info, 32);
}

function encryptJson(obj, key, meta) {
  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 2,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
    meta,
  };
}

function decryptJson(payload, key) {
  if (!payload || payload.alg !== 'aes-256-gcm') throw new Error('Unsupported config format');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function todayLocalYYYYMMDD() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function backupCurrentConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(CONFIG_DIR, `config.enc.${stamp}.json`);
  try {
    fs.copyFileSync(CONFIG_PATH, backupPath);
  } catch {}
}

function pruneBackups() {
  let entries = [];
  try {
    entries = fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith('config.enc.') && f.endsWith('.json'));
  } catch {
    return;
  }

  // keep newest N days worth (best-effort: delete by mtime beyond BACKUP_DAYS)
  const cutoff = Date.now() - BACKUP_DAYS * 24 * 60 * 60 * 1000;
  for (const f of entries) {
    const full = path.join(CONFIG_DIR, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {}
  }
}

async function saveConfig(configObj) {
  const masterKey = await readOrCreateMasterKey();
  const dateStr = todayLocalYYYYMMDD();
  const key = hkdfDailyKey(masterKey, dateStr);

  ensureDir();
  backupCurrentConfig();

  const payload = encryptJson(configObj, key, { date: dateStr });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });

  pruneBackups();

  return { configPath: CONFIG_PATH, keyStorage: 'keychain', backupsKeptDays: BACKUP_DAYS };
}

async function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return null;

  const masterKey = await readOrCreateMasterKey();
  const payload = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Try the recorded date first, then fall back to last BACKUP_DAYS dates in case of clock issues
  const candidateDates = [];
  if (payload?.meta?.date) candidateDates.push(payload.meta.date);

  // Add recent dates
  for (let i = 0; i <= BACKUP_DAYS; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const s = `${yyyy}-${mm}-${dd}`;
    if (!candidateDates.includes(s)) candidateDates.push(s);
  }

  let lastErr = null;
  for (const dateStr of candidateDates) {
    try {
      const key = hkdfDailyKey(masterKey, dateStr);
      return decryptJson(payload, key);
    } catch (e) {
      lastErr = e;
    }
  }

  const err = new Error('Unable to decrypt config with available rolling keys');
  err.cause = lastErr;
  throw err;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  SERVICE_NAME,
  ACCOUNT_NAME,
  BACKUP_DAYS,
  saveConfig,
  loadConfig,
};
