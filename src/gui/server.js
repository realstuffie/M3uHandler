'use strict';

const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { convertM3U } = require('../convert');
const { fetchPagedM3U } = require('../paged-fetch');
const { fetchWithTimeout } = require('../fetch-util');
const { loadConfig, saveConfig, safeUrlHost, CONFIG_PATH } = require('../plain-config');
const { verifyUserPassword, hasUser } = require('./auth-store');

const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

const app = express();

// Upload to OS temp dir
const uploadDir = path.join(os.tmpdir(), 'm3uHandlerUploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  // Limit upload size to reduce DoS risk. Increase if you have very large playlists.
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MiB
});

app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  // Minimal cookie parsing (avoid extra deps)
  const cookieHeader = req.headers.cookie || '';
  const cookies = {};
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    cookies[k] = v;
  });
  req.cookies = cookies;
  next();
});
app.use('/static', express.static(path.join(__dirname, 'static')));

if (!process.env.GUI_SESSION_SECRET || process.env.GUI_SESSION_SECRET.length < 32) {
  console.error('GUI_SESSION_SECRET is required (>= 32 chars). Refusing to start.');
  process.exit(1);
}

const GUI_HOST = process.env.GUI_HOST || '127.0.0.1';
const GUI_PORT = Number(process.env.PORT || 5177);

// Reverse proxy support (optional): set TRUST_PROXY=1 when behind Nginx/Caddy/Traefik.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// Cookie security:
// - COOKIE_SECURE=auto (recommended behind HTTPS proxy)
// - COOKIE_SECURE=true / false
const cookieSecure = (() => {
  const v = String(process.env.COOKIE_SECURE || '').toLowerCase().trim();
  if (v === 'auto') return 'auto';
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0' || v === '') return false;
  return false;
})();

app.use(
  session({
    secret: process.env.GUI_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: cookieSecure },
  })
);

// CSRF protection removed per request

// Rate limit login posts (10 per 15m per IP)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

// Avoid browser console 404s
app.get('/favicon.ico', (req, res) => res.status(204).end());

function isAuthed(req) {
  return Boolean(req.session && req.session.user === 'admin');
}

function requireAuth(req, res, next) {
  const openPaths = ['/login'];
  if (req.path.startsWith('/static') || openPaths.includes(req.path)) return next();
  if (isAuthed(req)) return next();
  res.redirect('/login');
}
app.use(requireAuth);

app.get('/login', async (req, res) => {
  const adminExists = await hasUser('admin').catch(() => false);
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>m3uHandler - Login</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <div class="wrap">
    <h1>m3uHandler</h1>
    <div class="card">
      <h2>Login</h2>
      ${adminExists ? '' : '<p><b>Admin user not set.</b> Run: <code>npm run gui-user -- set --username admin --password ...</code></p>'}
      <form method="post" action="/login">
        <label class="block">
          <span>Username</span>
          <input type="text" name="username" value="admin" required />
        </label>
        <label class="block">
          <span>Password</span>
          <input type="password" name="password" required />
        </label>
        <button type="submit">Login</button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

app.post('/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const ok = await verifyUserPassword(username, password).catch(() => false);
  if (!ok) {
    res.status(401).type('html').send('Login failed. <a href="/login">Try again</a>.');
    return;
  }

  req.session.user = username;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

const loadedCfg = loadConfig();

let daemonState = {
  tv: {
    running: false,
    url: loadedCfg?.urlTv || '',
    outDir: path.resolve(loadedCfg?.out || 'output'),
    includeLive: false,
    moviesFlat: false,
    intervalHours: Number.isFinite(loadedCfg?.intervalHours) ? loadedCfg.intervalHours : 24,
    lastRun: null,
    lastResult: null,
    lastError: null,
    stopRequested: false,
  },
  movies: {
    running: false,
    url: loadedCfg?.urlMovies || '',
    outDir: path.resolve(loadedCfg?.out || 'output'),
    includeLive: false,
    moviesFlat: Boolean(loadedCfg?.moviesFlat),
    intervalHours: Number.isFinite(loadedCfg?.intervalHours) ? loadedCfg.intervalHours : 24,
    lastRun: null,
    lastResult: null,
    lastError: null,
    stopRequested: false,
  },
};

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function fetchJobPlaylist(jobKey, url) {
  // TV job may be paged: user may provide .../tvshows or .../tvshows/
  if (jobKey === 'tv' && /\/tvshows\/?$/.test(url)) {
    const baseUrl = url.endsWith('/') ? url : `${url}/`;
    return await fetchPagedM3U({ baseUrl, maxPages: 50 });
  }
  return await fetchText(url);
}

function safeUrlHint(u) {
  return safeUrlHost(u);
}

function renderJobCard(jobKey, job) {
  const title = jobKey === 'tv' ? 'TV' : 'Movies';
  const runningHtml = job.running
    ? `<div><b>Status:</b> Running</div>`
    : `<div><b>Status:</b> Stopped</div>`;
  return `<div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center">
      <div><b>${title} daemon</b></div>
      <form method="post" action="/daemon/${jobKey}/stop" style="margin:0">
        <button type="submit">${job.running ? 'Stop' : 'Stop (not running)'}</button>
      </form>
    </div>
    ${runningHtml}
    <div><b>URL host:</b> <code>${job.url ? safeUrlHint(job.url) : ''}</code></div>
    <div><b>Output:</b> <code>${job.outDir}</code></div>
    <div><b>Interval:</b> ${job.intervalHours}h</div>
    ${job.lastRun ? `<div><b>Last run:</b> ${job.lastRun}</div>` : ''}
    ${job.lastResult ? `<div><b>Last result:</b> written=${job.lastResult.written} skipped=${job.lastResult.skipped} ignored=${job.lastResult.ignored} deleted=${job.lastResult.deleted}</div>` : ''}
    ${job.lastError ? `<div><b>Last error:</b> <code>${String(job.lastError).replace(/</g, '<')}</code></div>` : ''}
  </div>`;
}

function renderHome(req) {
  const stateHtml = `${renderJobCard('tv', daemonState.tv)}${renderJobCard('movies', daemonState.movies)}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>m3uHandler GUI</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <div class="wrap">
    <h1>m3uHandler</h1>

    <h2>One-time convert (upload)</h2>
    <p>Upload your playlist and generate categorized <code>.strm</code> files.</p>

    <form method="post" action="/convert" enctype="multipart/form-data">
      <label class="block">
        <span>M3U/M3U8 file</span>
        <input type="file" name="playlist" accept=".m3u,.m3u8,.txt" required />
      </label>

      <label class="block">
        <span>Output directory (server path)</span>
        <input type="text" name="outDir" value="${path.resolve('output')}" />
        <small>Note: this is the folder on the machine running the GUI.</small>
      </label>

      <label class="block check">
        <input type="checkbox" name="includeLive" />
        <span>Include live channels</span>
      </label>

      <label class="block check">
        <input type="checkbox" name="overwrite" />
        <span>Overwrite existing .strm files</span>
      </label>

      <label class="block check">
        <input type="checkbox" name="moviesFlat" />
        <span>Movies flat (no Movies/<Year>/ folders)</span>
      </label>

      <button type="submit">Convert</button>
    </form>

    <h2 style="margin-top: 28px">Daemon (auto-update from URL)</h2>
    <p>Runs in the background inside this GUI process. It fetches each URL every N hours and deletes missing <code>.strm</code> files.</p>

    ${stateHtml}

    <form method="post" action="/daemon/start" style="margin-top: 12px">
      <label class="block">
        <span>TV M3U URL</span>
        <input type="text" name="urlTv" placeholder="https://...tv..." ${daemonState.tv.url ? '' : 'required'} />
      </label>

      <label class="block">
        <span>Movies M3U URL</span>
        <input type="text" name="urlMovies" placeholder="https://...movies..." ${daemonState.movies.url ? '' : 'required'} />
        <small>Stored in hidden file: <code>${CONFIG_PATH}</code> (not encrypted).</small>
      </label>

      <label class="block">
        <span>Output directory root (server path)</span>
        <input type="text" name="outDir" value="${daemonState.tv.outDir}" />
        <small>TV writes under <code>TV Shows/</code> and Movies writes under <code>Movies/</code> in the same root.</small>
      </label>

      <label class="block">
        <span>Interval (hours)</span>
        <input type="text" name="intervalHours" value="${daemonState.tv.intervalHours}" />
      </label>


      <label class="block check">
        <input type="checkbox" name="moviesFlat" />
        <span>Movies flat (no Movies/<Year>/ folders)</span>
      </label>

      <button type="submit">Start both daemons</button>
    </form>

    <div class="actions">
      <a class="btn secondary" href="/daemon/status" target="_blank" rel="noreferrer">Open JSON status</a>
    </div>
  </div>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.type('html').send(renderHome(req));
});

async function startDaemonJob(jobKey) {
  const job = daemonState[jobKey];
  if (job.running) return;

  job.running = true;
  job.stopRequested = false;

  (async () => {
    while (job.running && !job.stopRequested) {
      job.lastRun = new Date().toISOString();
      job.lastError = null;
      try {
        const text = await fetchJobPlaylist(jobKey, job.url);
        const tmp = path.join(uploadDir, `${jobKey}-daemon-${Date.now()}-${Math.random().toString(16).slice(2)}.m3u8`);
        await fs.promises.writeFile(tmp, text, 'utf8');
        try {
          const { stats } = await convertM3U({
            inputPath: tmp,
            outRoot: job.outDir,
            includeLive: job.includeLive,
            overwrite: true,
            moviesByYear: jobKey === 'movies' ? !job.moviesFlat : true,
            deleteMissing: true,
            dryRun: false,
            ignoredLogPath: path.join(job.outDir, '.logs', `${jobKey}-ignored.ndjson`),
            defaultType: jobKey === 'movies' ? 'movies' : 'tvshows',
          });
          job.lastResult = stats;
        } finally {
          fs.promises.unlink(tmp).catch(() => {});
        }
      } catch (e) {
        job.lastError = String(e?.message || e);
      }

      const ms = job.intervalHours * 60 * 60 * 1000;
      await new Promise((r) => setTimeout(r, ms));
    }
    job.running = false;
    job.stopRequested = false;
  })().catch(() => {});
}

app.post('/daemon/start', async (req, res) => {
  try {
    const urlTv = String(req.body.urlTv || '').trim() || daemonState.tv.url;
    const urlMovies = String(req.body.urlMovies || '').trim() || daemonState.movies.url;
    if (!urlTv || !urlMovies) {
      res.status(400).type('html').send('Missing urlTv or urlMovies');
      return;
    }

    const outRoot = path.resolve(req.body.outDir || daemonState.tv.outDir || 'output');
    const intervalHours = Number(req.body.intervalHours || daemonState.tv.intervalHours || 24);
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      res.status(400).type('html').send('Invalid intervalHours');
      return;
    }

    const moviesFlat = req.body.moviesFlat === 'on';

    // persist latest daemon settings (plaintext)
    saveConfig({
      out: outRoot,
      intervalHours,
      urlTv,
      urlMovies,
      moviesFlat,
    });

    daemonState.tv.url = urlTv;
    daemonState.movies.url = urlMovies;
    daemonState.tv.outDir = outRoot;
    daemonState.movies.outDir = outRoot;
    daemonState.tv.intervalHours = intervalHours;
    daemonState.movies.intervalHours = intervalHours;
    daemonState.tv.includeLive = false;
    daemonState.movies.moviesFlat = moviesFlat;

    await startDaemonJob('tv');
    await startDaemonJob('movies');
  } catch (e) {
    res.status(500).type('html').send(`<pre>${String(e?.stack || e)}</pre>`);
    return;
  }
  res.redirect('/');
});

app.post('/daemon/:job/stop', (req, res) => {
  const jobKey = req.params.job;
  if (jobKey !== 'tv' && jobKey !== 'movies') {
    res.status(404).end();
    return;
  }
  daemonState[jobKey].stopRequested = true;
  res.redirect('/');
});

app.get('/daemon/status', (req, res) => {
  res.json({
    tv: daemonState.tv,
    movies: daemonState.movies,
  });
});

app.post('/convert', upload.single('playlist'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).type('html').send('Missing upload');
      return;
    }

    const outRoot = path.resolve(req.body.outDir || 'output');
    const includeLive = req.body.includeLive === 'on';
    const overwrite = req.body.overwrite === 'on';
    const moviesByYear = req.body.moviesFlat === 'on' ? false : true;

    const { stats, lastWritten } = await convertM3U({
      inputPath: req.file.path,
      outRoot,
      includeLive,
      overwrite,
      moviesByYear,
      dryRun: false,
    });

    res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>m3uHandler - done</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <div class="wrap">
    <h1>Done</h1>
    <div class="card">
      <div><b>Written:</b> ${stats.written}</div>
      <div><b>Skipped (exists):</b> ${stats.skipped}</div>
      <div><b>Ignored:</b> ${stats.ignored}</div>
      <div><b>Output:</b> <code>${outRoot}</code></div>
      ${lastWritten ? `<div><b>Example:</b> <code>${lastWritten.outPath}</code></div>` : ''}
    </div>
    <p><a href="/">Convert another</a></p>
  </div>
</body>
</html>`);
  } catch (e) {
    res.status(500).type('html').send(`<pre>${String(e?.stack || e)}</pre>`);
  } finally {
    // Best-effort cleanup
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

function tryOpenWindowsFirewallPort(port) {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');

  const ruleName = 'm3uHandler GUI';
  // netsh requires admin; if not admin, it will fail (we only warn).
  execFile(
    'netsh',
    ['advfirewall', 'firewall', 'add', 'rule', `name=${ruleName}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`],
    { windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        console.warn(
          `Windows firewall rule was not added (admin required). You may need to run PowerShell as Administrator:\n` +
            `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`
        );
        return;
      }
      if (stdout || stderr) {
        console.log(String(stdout || stderr).trim());
      }
      console.log(`Windows firewall rule ensured for TCP ${port} (${ruleName}).`);
    }
  );
}

app.listen(GUI_PORT, GUI_HOST, () => {
  console.log(`m3uHandler GUI running at http://${GUI_HOST}:${GUI_PORT}`);
  if (GUI_HOST === '0.0.0.0') tryOpenWindowsFirewallPort(GUI_PORT);
});
