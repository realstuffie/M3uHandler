const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertM3U } = require('../src/convert');

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `m3uHandler-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE = `#EXTM3U
#EXTINF:-1 tvg-id="tt37443891" tvg-name="tt37443891" tvg-type="movies" group-title="Movies 2025" ,Raat Akeli Hai - The Bansal Murders (2025)
https://starlite.best/api/stream/user/pass/movie/tt37443891
#EXTINF:-1 tvg-id="tt33501959" tvg-name="tt33501959" tvg-type="tvshows" group-title="Land of Sin (2026)" ,Land of Sin (2026) S01 E01
https://starlite.best/api/stream/user/pass/tvshow/tt33501959/1/1
#EXTINF:-1 tvg-id="5.star.max.eastern.us" tvg-name="5.star.max.eastern.us" tvg-type="live" group-title="US" tvg-logo="https://media.starlite.best/5.star.max.eastern.us.png",5 Star Max (East)
https://starlite.best/api/stream/user/pass/livetv.epg/5.star.max.eastern.us.m3u8
`;

test('generate movie+tv and ignore live when includeLive=false (dry-run)', async () => {
  const dir = makeTempDir();
  const infile = path.join(dir, 'sample.m3u8');
  fs.writeFileSync(infile, SAMPLE, 'utf8');

  const res = await convertM3U({
    inputPath: infile,
    outRoot: dir,
    includeLive: false,
    overwrite: true,
    dryRun: true,
    moviesByYear: true,
    deleteMissing: false,
    ignoredLogPath: path.join(dir, '.logs', 'ignored.ndjson'),
  });

  expect(res.stats.written).toBe(2);
  expect(res.stats.ignored).toBe(1);
  expect(res.lastWritten).toBeTruthy();
});

test('generate movie+tv+live when includeLive=true (dry-run)', async () => {
  const dir = makeTempDir();
  const infile = path.join(dir, 'sample.m3u8');
  fs.writeFileSync(infile, SAMPLE, 'utf8');

  const res = await convertM3U({
    inputPath: infile,
    outRoot: dir,
    includeLive: true,
    overwrite: true,
    dryRun: true,
    moviesByYear: true,
    deleteMissing: false,
    ignoredLogPath: path.join(dir, '.logs', 'ignored.ndjson'),
  });

  expect(res.stats.written).toBe(3);
  expect(res.stats.ignored).toBe(0);
  expect(res.lastWritten).toBeTruthy();
});
