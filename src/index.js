#!/usr/bin/env node
'use strict';

const path = require('path');
const { convertM3U } = require('./convert');

function parseArgs(argv) {
  const args = {
    input: null,
    out: 'output',
    includeLive: false,
    overwrite: false,
    dryRun: false,
    moviesByYear: true,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') args.input = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--include-live') args.includeLive = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--movies-flat') args.moviesByYear = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

function usage() {
  return `
m3uHandler - split an M3U/M3U8 playlist into categorized .strm files

Usage:
  node src/index.js --input <playlist.m3u8> [options]

Options:
  -i, --input <file>       Input playlist file (required)
  -o, --out <dir>          Output directory (default: output)
      --include-live       Also write live .strm entries (default: off)
      --overwrite          Overwrite existing .strm files (default: skip)
      --dry-run            Print what would be written (no filesystem writes)
      --movies-flat        Put movies directly under Movies/ (no Movies/<Year>/)
  -h, --help               Show help
`.trim();
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const inputPath = path.resolve(args.input);
  const outRoot = path.resolve(args.out);

  const { stats } = await convertM3U({
    inputPath,
    outRoot,
    includeLive: args.includeLive,
    overwrite: args.overwrite,
    dryRun: args.dryRun,
    moviesByYear: args.moviesByYear,
  });

  console.log(`Done.
Written: ${stats.written}
Skipped (exists): ${stats.skipped}
Ignored: ${stats.ignored}
Output: ${outRoot}`);
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
