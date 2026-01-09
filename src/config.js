#!/usr/bin/env node
'use strict';

const { saveConfig, loadConfig, CONFIG_PATH, safeUrlHost } = require('./plain-config');

function parseArgs(argv) {
  const args = { cmd: null, url: null, out: null, intervalHours: null, includeLive: null, moviesFlat: null };

  const [, , cmd, ...rest] = argv;
  args.cmd = cmd || null;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--url') args.url = rest[++i];
    else if (a === '--out') args.out = rest[++i];
    else if (a === '--interval-hours') args.intervalHours = Number(rest[++i]);
    else if (a === '--include-live') args.includeLive = true;
    else if (a === '--movies-flat') args.moviesFlat = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

function usage() {
  return `
m3uHandler config (plaintext, hidden in ~/.config/m3uHandler/config.json)

Usage:
  node src/config.js init --url "<m3u_url>" [--out ./output] [--interval-hours 24] [--include-live] [--movies-flat]
  node src/config.js show
`.trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.cmd) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  if (args.cmd === 'init') {
    if (!args.url) {
      console.error('Missing --url');
      process.exit(1);
    }
    const cfg = {
      url: args.url,
      out: args.out || 'output',
      intervalHours: Number.isFinite(args.intervalHours) ? args.intervalHours : 24,
      includeLive: Boolean(args.includeLive),
      moviesFlat: Boolean(args.moviesFlat),
    };
    saveConfig(cfg);
    console.log(`Saved config: ${CONFIG_PATH}`);
    return;
  }

  if (args.cmd === 'show') {
    const cfg = loadConfig();
    if (!cfg) {
      console.log('No config found.');
      return;
    }
    console.log({
      urlHost: safeUrlHost(cfg.url),
      out: cfg.out,
      intervalHours: cfg.intervalHours,
      includeLive: cfg.includeLive,
      moviesFlat: cfg.moviesFlat,
    });
    return;
  }

  console.log(usage());
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
