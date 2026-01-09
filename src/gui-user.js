#!/usr/bin/env node
'use strict';

const { setUserPassword } = require('./gui/auth-store');

function parseArgs(argv) {
  const args = { cmd: null, username: null, password: null };
  const [, , cmd, ...rest] = argv;
  args.cmd = cmd || null;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--username' || a === '-u') args.username = rest[++i];
    else if (a === '--password' || a === '-p') args.password = rest[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function usage() {
  return `
m3uHandler GUI user management (stored in OS keychain)

Usage:
  node src/gui-user.js set --username <name> --password <pass>
`.trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.cmd) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  if (args.cmd === 'set') {
    if (!args.username || !args.password) {
      console.error('Missing --username or --password');
      process.exit(1);
    }
    await setUserPassword(args.username, args.password);
    console.log(`Saved GUI user '${args.username}' to OS keychain.`);
    return;
  }

  console.log(usage());
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});