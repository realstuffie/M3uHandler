'use strict';

const { spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

async function main() {
  // Prefer npm because this repo uses package-lock.json
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install'];
  console.log(`Running: ${cmd} ${args.join(' ')}`);
  await run(cmd, args);
  console.log('Dependencies installed.');
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});