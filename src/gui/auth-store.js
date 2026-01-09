'use strict';

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const envPathsMod = require('env-paths');

const SERVICE = 'm3uHandler-gui';
const ACCOUNT_PREFIX = 'user:';

const envPaths = envPathsMod.default || envPathsMod;
const paths = envPaths('m3uHandler');
const fallbackAuthPath = path.join(paths.config, 'gui-auth.json');

async function getKeytarOptional() {
  // Auto-detect: if keytar can't be loaded (native module missing), fall back to file.
  try {
    const mod = await import('keytar');
    return mod.default || mod;
  } catch {
    return null;
  }
}

function accountForUser(username) {
  return `${ACCOUNT_PREFIX}${username}`;
}

async function readFallback() {
  try {
    const raw = await fs.promises.readFile(fallbackAuthPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { users: {} };
  }
}

async function writeFallback(data) {
  await fs.promises.mkdir(path.dirname(fallbackAuthPath), { recursive: true });
  const tmp = `${fallbackAuthPath}.tmp`;
  // best-effort permissions (Windows ignores mode)
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, fallbackAuthPath);
}

async function setUserPassword(username, password) {
  const hash = await bcrypt.hash(password, 12);

  const keytar = await getKeytarOptional();
  if (keytar) {
    await keytar.setPassword(SERVICE, accountForUser(username), hash);
    return;
  }

  const data = await readFallback();
  data.users = data.users || {};
  data.users[username] = { hash };
  await writeFallback(data);
}

async function verifyUserPassword(username, password) {
  const keytar = await getKeytarOptional();
  if (keytar) {
    const hash = await keytar.getPassword(SERVICE, accountForUser(username));
    if (!hash) return false;
    return await bcrypt.compare(password, hash);
  }

  const data = await readFallback();
  const hash = data?.users?.[username]?.hash;
  if (!hash) return false;
  return await bcrypt.compare(password, hash);
}

async function hasUser(username) {
  const keytar = await getKeytarOptional();
  if (keytar) {
    const hash = await keytar.getPassword(SERVICE, accountForUser(username));
    return Boolean(hash);
  }

  const data = await readFallback();
  return Boolean(data?.users?.[username]?.hash);
}

module.exports = {
  setUserPassword,
  verifyUserPassword,
  hasUser,
  fallbackAuthPath,
};
