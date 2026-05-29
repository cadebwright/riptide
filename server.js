try { require('dotenv').config(); } catch (e) {} // load .env if present (optional)
const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const archiver = require('archiver');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const analytics = require('./analytics');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// --- Cloudflare Turnstile (bot protection) ---
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_ENABLED = !!TURNSTILE_SITE_KEY && !!TURNSTILE_SECRET;

// Secret for signing admin session cookies. Derived from existing config so no
// extra env var is required; changing ADMIN_PASSWORD invalidates old sessions.
const SESSION_SECRET = process.env.SESSION_SECRET
  || ((process.env.ADMIN_PASSWORD || 'riptide') + (process.env.ANALYTICS_SALT || 'salt'));

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// --- Security middleware ---

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://i1.sndcdn.com", "https://*.sndcdn.com", "data:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameSrc: ["https://challenges.cloudflare.com"],
    }
  }
}));

// Trust Heroku's proxy for rate limiting by IP
app.set('trust proxy', 1);

// Rate limiting: general API
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,                  // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' }
});

// Rate limiting: downloads (stricter)
const downloadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15,                  // 15 downloads per 5 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Download limit reached. Please wait a few minutes.' }
});

// Rate limiting: admin login (strict — brute-force protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// --- Analytics: log a page visit on the root request ---
app.get('/', (req, res, next) => {
  try { analytics.logVisit(req); } catch (e) {}
  next();
});

// --- Cloudflare Turnstile verification ---

// Expose public client config (safe to send the site key — it's public by design).
app.get('/api/config', (req, res) => {
  res.json({ turnstile: { enabled: TURNSTILE_ENABLED, siteKey: TURNSTILE_SITE_KEY } });
});

async function verifyTurnstile(token, ip) {
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const data = await r.json();
    return !!data.success;
  } catch (e) {
    console.error('[turnstile] verify error:', e.message);
    return false;
  }
}

// --- Admin dashboard auth (cookie session set by the custom login page) ---
function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.rt_admin;
  if (token) {
    try { jwt.verify(token, SESSION_SECRET); return next(); } catch (e) {}
  }
  // API calls get a 401; page requests are redirected to the login page.
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/stats/login');
}

// Custom login page (public).
app.get('/stats/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Login: verify Turnstile (if enabled) + password, then set a session cookie.
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD on the server.' });
  }

  const { password, turnstileToken } = req.body || {};

  if (TURNSTILE_ENABLED) {
    const ok = await verifyTurnstile(turnstileToken, req.ip);
    if (!ok) return res.status(403).json({ error: 'Verification failed. Please retry the challenge.' });
  }

  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = jwt.sign({ admin: true }, SESSION_SECRET, { expiresIn: '7d' });
  res.cookie('rt_admin', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('rt_admin');
  res.json({ ok: true });
});

// Stats dashboard page + API (registered before express.static so they stay protected)
app.get(['/stats', '/stats.html'], requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await analytics.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Resolve yt-dlp: prefer local bin (Heroku), fall back to global (local dev)
const LOCAL_YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const YTDLP = fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp';

const activeDownloads = new Map();
const jobs = new Map();

const MAX_PLAYLIST_TRACKS = 50;
const MAX_CONCURRENT_JOBS = 5;
const TRACK_CONCURRENCY = 3;

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 10 * 60 * 1000) {
      if (job.batchDir) cleanupDir(job.batchDir);
      if (job.previewDir) cleanupDir(job.previewDir);
      if (job.zipPath) try { fs.unlinkSync(job.zipPath); } catch (e) {}
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

// --- URL validation ---

function isValidSoundCloudUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    // Must be HTTPS (or HTTP) with a soundcloud.com hostname
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'soundcloud.com' && !host.endsWith('.soundcloud.com')) return false;
    // Must have a path beyond just /
    if (parsed.pathname.length <= 1) return false;
    return true;
  } catch {
    return false;
  }
}

// --- Routes ---

// Extract a readable name from a SoundCloud URL slug
function nameFromUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Last segment is the track slug, second-to-last is the artist
    const slug = parts[parts.length - 1] || '';
    const artist = parts.length >= 2 ? parts[parts.length - 2] : '';
    const titleize = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { title: titleize(slug), artist: titleize(artist) };
  } catch {
    return { title: 'Unknown', artist: 'Unknown' };
  }
}

// Get track/playlist info
// Single tracks: full metadata (fast for 1 track)
// Playlists: fast --flat-playlist with names parsed from URL slugs
//            Real metadata arrives via SSE as tracks download
app.post('/api/info', apiLimiter, (req, res) => {
  const { url } = req.body;
  if (!url || !isValidSoundCloudUrl(url)) {
    return res.status(400).json({ error: 'Invalid SoundCloud URL' });
  }

  // First: fast flat-playlist to detect type and get URLs
  execFile(YTDLP, [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    url
  ], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch track info. Make sure yt-dlp is installed.' });
    }

    try {
      const lines = stdout.trim().split('\n');
      const entries = lines.map(line => JSON.parse(line));
      const isPlaylist = entries[0].playlist_title || entries[0].playlist || entries.length > 1;

      if (!isPlaylist && entries.length === 1) {
        // Single track — full metadata fetch (fast for just 1)
        const trackUrl = entries[0].url || entries[0].webpage_url || url;
        execFile(YTDLP, [
          '--dump-json',
          '--no-warnings',
          '--no-download',
          trackUrl
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err2, stdout2) => {
          if (err2) {
            const fallback = nameFromUrl(trackUrl);
            return res.json({
              type: 'track',
              title: fallback.title,
              artist: fallback.artist,
              album: '', artwork: '', duration: 0,
              url: trackUrl
            });
          }
          const t = JSON.parse(stdout2.trim().split('\n')[0]);
          return res.json({
            type: 'track',
            title: t.fulltitle || t.title || t.track || 'Unknown',
            artist: t.artist || t.uploader || t.creator || t.channel || 'Unknown',
            album: t.album || '',
            artwork: getBestThumbnail(t),
            duration: t.duration || 0,
            url: t.webpage_url || trackUrl
          });
        });
        return;
      }

      // Playlist — return immediately with URL-derived names
      const playlistTitle = entries[0].playlist_title || entries[0].playlist || 'Playlist';
      const tracks = entries.slice(0, MAX_PLAYLIST_TRACKS).map(t => {
        const trackUrl = t.url || t.webpage_url || '';
        const parsed = nameFromUrl(trackUrl);
        return {
          title: t.title || parsed.title,
          artist: t.uploader || t.artist || parsed.artist,
          album: '',
          artwork: t.thumbnail || '',
          duration: t.duration || 0,
          url: trackUrl
        };
      });

      const response = { type: 'playlist', title: playlistTitle, tracks };
      if (entries.length > MAX_PLAYLIST_TRACKS) {
        response.truncated = true;
        response.totalAvailable = entries.length;
      }
      return res.json(response);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse track info' });
    }
  });
});

// Download single track
app.post('/api/download', downloadLimiter, (req, res) => {
  const { url, format = 'mp3', sessionId, title, artist } = req.body;
  const logTrack = { url, title, artist };

  if (!url || !isValidSoundCloudUrl(url)) {
    return res.status(400).json({ error: 'Invalid SoundCloud URL' });
  }

  const allowedFormats = ['mp3', 'wav', 'aac', 'flac'];
  if (!allowedFormats.includes(format)) {
    return res.status(400).json({ error: 'Invalid format' });
  }

  const fileId = randomUUID();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${fileId}.%(ext)s`);

  const args = [
    '-x',
    '--audio-format', format,
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--add-metadata',
    '--no-playlist',
    '--no-warnings',
    '-o', outputTemplate,
  ];

  if (format === 'mp3' || format === 'aac') {
    args.push('--postprocessor-args', 'ffmpeg:-b:a 320k');
  }

  args.push(url);

  const proc = spawn(YTDLP, args, { timeout: 120000 });

  if (sessionId) {
    if (!activeDownloads.has(sessionId)) activeDownloads.set(sessionId, []);
    activeDownloads.get(sessionId).push(proc);
  }

  let killed = false;

  proc.on('close', (code) => {
    if (sessionId && activeDownloads.has(sessionId)) {
      const procs = activeDownloads.get(sessionId).filter(p => p !== proc);
      if (procs.length === 0) activeDownloads.delete(sessionId);
      else activeDownloads.set(sessionId, procs);
    }

    if (killed) return;

    if (code !== 0) {
      cleanup(fileId);
      analytics.logDownload(req, { kind: 'single', format, status: 'failed', tracks: [logTrack] });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Download failed. Make sure yt-dlp and ffmpeg are installed.' });
      }
      return;
    }

    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      analytics.logDownload(req, { kind: 'single', format, status: 'failed', tracks: [logTrack] });
      if (!res.headersSent) return res.status(500).json({ error: 'Conversion failed' });
      return;
    }

    const audioExts = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus', 'ogg'];
    const audioFile = files.find(f => audioExts.includes(path.extname(f).slice(1))) || files[0];
    const outputFile = path.join(DOWNLOADS_DIR, audioFile);
    const ext = path.extname(audioFile).slice(1);

    const mimeTypes = {
      mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
      flac: 'audio/flac', m4a: 'audio/mp4', opus: 'audio/opus', ogg: 'audio/ogg'
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download.${ext}"`);

    analytics.logDownload(req, { kind: 'single', format, status: 'success', tracks: [logTrack] });

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => cleanup(fileId));
    stream.on('error', () => {
      cleanup(fileId);
      if (!res.headersSent) res.status(500).json({ error: 'File read error' });
    });
  });

  res.on('close', () => {
    if (!res.writableFinished && !proc.killed) {
      killed = true;
      proc.kill();
      cleanup(fileId);
    }
  });
});

// Start a playlist download job
app.post('/api/start-playlist', downloadLimiter, (req, res) => {
  const { tracks, format = 'mp3', playlistName } = req.body;

  if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'No tracks provided' });
  }

  if (tracks.length > MAX_PLAYLIST_TRACKS) {
    return res.status(400).json({ error: `Maximum ${MAX_PLAYLIST_TRACKS} tracks per playlist` });
  }

  // Validate every track URL
  for (const track of tracks) {
    if (!track.url || !isValidSoundCloudUrl(track.url)) {
      return res.status(400).json({ error: 'Invalid track URL in playlist' });
    }
  }

  const allowedFormats = ['mp3', 'wav', 'aac', 'flac'];
  if (!allowedFormats.includes(format)) {
    return res.status(400).json({ error: 'Invalid format' });
  }

  // Limit concurrent jobs
  const activeJobs = [...jobs.values()].filter(j => j.status === 'downloading' || j.status === 'zipping');
  if (activeJobs.length >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: 'Server is busy. Please try again in a moment.' });
  }

  const jobId = randomUUID();
  const batchDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(batchDir);

  const previewDir = path.join(DOWNLOADS_DIR, jobId + '_previews');
  fs.mkdirSync(previewDir);

  const job = {
    status: 'downloading',
    progress: 0,
    currentTrack: 0,
    totalTracks: tracks.length,
    trackStatuses: tracks.map(() => 'pending'),
    previewReady: tracks.map(() => false),
    trackMeta: tracks.map(() => null),
    batchDir,
    previewDir,
    zipPath: null,
    error: null,
    cancelled: false,
    procs: [],
    createdAt: Date.now(),
    playlistName: playlistName || 'playlist',
  };

  jobs.set(jobId, job);

  job.analyticsPromise = analytics.logDownload(req, {
    kind: 'playlist',
    format,
    status: 'started',
    playlistName: playlistName || 'playlist',
    tracks: tracks.map(t => ({ url: t.url, title: t.title, artist: t.artist })),
  });

  res.json({ jobId });
  processPlaylist(jobId, tracks, format);
});

function downloadTrack(job, track, i, format) {
  return new Promise((resolve) => {
    if (job.cancelled) { resolve(); return; }

    job.trackStatuses[i] = 'downloading';

    const trackSafeName = (track.title || 'track').replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
    const fileId = randomUUID();
    const outputTemplate = path.join(job.batchDir, `${fileId}.%(ext)s`);

    const args = [
      '-x',
      '--audio-format', format,
      '--audio-quality', '0',
      '--embed-thumbnail',
      '--add-metadata',
      '--print-json',
      '--no-playlist',
      '--no-warnings',
      '-o', outputTemplate,
    ];

    if (format === 'mp3' || format === 'aac') {
      args.push('--postprocessor-args', 'ffmpeg:-b:a 320k');
    }

    args.push(track.url);

    const proc = spawn(YTDLP, args, { timeout: 120000 });
    job.procs.push(proc);

    // Capture stdout for metadata (--print-json writes JSON to stdout)
    let jsonOut = '';
    proc.stdout.on('data', (d) => { jsonOut += d.toString(); });

    proc.on('close', (code) => {
      if (job.cancelled) { resolve(); return; }

      if (code !== 0) {
        job.trackStatuses[i] = 'failed';
        resolve();
        return;
      }

      // Try to parse enriched metadata from yt-dlp output
      let parsedMeta = null;
      try {
        parsedMeta = JSON.parse(jsonOut.trim().split('\n').pop());
        job.trackMeta[i] = {
          title: parsedMeta.fulltitle || parsedMeta.title || track.title,
          artist: parsedMeta.artist || parsedMeta.uploader || parsedMeta.creator || track.artist,
          artwork: getBestThumbnail(parsedMeta),
          duration: parsedMeta.duration || track.duration || 0,
          genre: pickBestGenre(parsedMeta),
        };
      } catch (e) {}

      const files = fs.readdirSync(job.batchDir).filter(f => f.startsWith(fileId));
      const audioExts = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus', 'ogg'];
      const audioFile = files.find(f => audioExts.includes(path.extname(f).slice(1)));

      if (audioFile) {
        const ext = path.extname(audioFile).slice(1);
        const meta = job.trackMeta[i];
        const displayName = meta ? (meta.title || trackSafeName) : trackSafeName;
        const safeFinal = displayName.replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
        const newName = `${safeFinal}.${ext}`;
        const fullTrackPath = path.join(job.batchDir, newName);
        fs.renameSync(path.join(job.batchDir, audioFile), fullTrackPath);

        // Write accurate genre tag via ffmpeg (overwrites the broad SoundCloud category)
        const genre = meta && meta.genre;
        if (genre) {
          writeGenreTag(fullTrackPath, genre).catch(() => {});
        }

        job.trackStatuses[i] = 'done';

        const dur = (meta && meta.duration) || track.duration || 0;
        generatePreview(fullTrackPath, job.previewDir, i, dur)
          .then(() => { job.previewReady[i] = true; })
          .catch(() => {});
      } else {
        job.trackStatuses[i] = 'failed';
      }

      const leftover = fs.readdirSync(job.batchDir).filter(f => f.startsWith(fileId));
      leftover.forEach(f => { try { fs.unlinkSync(path.join(job.batchDir, f)); } catch (e) {} });

      resolve();
    });

    proc.on('error', () => {
      job.trackStatuses[i] = 'failed';
      resolve();
    });
  });
}

async function processPlaylist(jobId, tracks, format) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Concurrent download pool
  let nextIndex = 0;

  function updateProgress() {
    const done = job.trackStatuses.filter(s => s === 'done' || s === 'failed').length;
    job.progress = Math.round((done / tracks.length) * 90);
    job.currentTrack = Math.min(nextIndex, tracks.length - 1);
  }

  async function worker() {
    while (nextIndex < tracks.length && !job.cancelled) {
      const i = nextIndex++;
      await downloadTrack(job, tracks[i], i, format);
      updateProgress();
    }
  }

  // Launch workers
  const workers = [];
  for (let w = 0; w < Math.min(TRACK_CONCURRENCY, tracks.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (job.cancelled) {
    job.status = 'cancelled';
    cleanupDir(job.batchDir);
    if (job.previewDir) cleanupDir(job.previewDir);
    if (job.analyticsPromise) job.analyticsPromise.then(id => analytics.updateStatus(id, 'cancelled'));
    return;
  }

  job.progress = 95;
  job.status = 'zipping';

  const zipPath = path.join(DOWNLOADS_DIR, `${jobId}.zip`);
  job.zipPath = zipPath;

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 1 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      // Add only audio files, not the _previews subdirectory
      const audioExts = ['.mp3', '.wav', '.aac', '.flac', '.m4a', '.opus', '.ogg'];
      const files = fs.readdirSync(job.batchDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return audioExts.includes(ext) && !f.startsWith('.');
      });
      for (const file of files) {
        archive.file(path.join(job.batchDir, file), { name: file });
      }
      archive.finalize();
    });

    job.status = 'complete';
    job.progress = 100;
    cleanupDir(job.batchDir);
    job.batchDir = null;
    const okCount = job.trackStatuses.filter(s => s === 'done').length;
    if (job.analyticsPromise) job.analyticsPromise.then(id => analytics.updateStatus(id, 'complete', okCount));
  } catch (err) {
    job.status = 'error';
    job.error = 'Failed to create zip file';
    cleanupDir(job.batchDir);
    if (job.analyticsPromise) job.analyticsPromise.then(id => analytics.updateStatus(id, 'error'));
  }
}

// SSE endpoint for playlist progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  // Validate jobId is a UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const job = jobs.get(jobId);
    if (!job) {
      res.write(`data: ${JSON.stringify({ status: 'error', error: 'Job lost' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      currentTrack: job.currentTrack,
      totalTracks: job.totalTracks,
      trackStatuses: job.trackStatuses,
      previewReady: job.previewReady,
      trackMeta: job.trackMeta,
      error: job.error,
    })}\n\n`);

    if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// Download the completed zip
app.get('/api/download-zip/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = jobs.get(jobId);

  if (!job || job.status !== 'complete' || !job.zipPath) {
    return res.status(404).json({ error: 'Zip not ready' });
  }

  if (!fs.existsSync(job.zipPath)) {
    return res.status(404).json({ error: 'Zip file not found' });
  }

  const safeName = (job.playlistName || 'playlist').replace(/[<>:"/\\|?*]/g, '').substring(0, 80);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

  const stream = fs.createReadStream(job.zipPath);
  stream.pipe(res);
  stream.on('end', () => {
    try { fs.unlinkSync(job.zipPath); } catch (e) {}
    if (job.previewDir) cleanupDir(job.previewDir);
    jobs.delete(jobId);
  });
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'File read error' });
  });
});

// Known specific sub-genres (more useful for Rekordbox than SoundCloud's broad categories)
const SPECIFIC_GENRES = [
  'Tech House', 'Deep House', 'Progressive House', 'Electro House', 'Future House',
  'Bass House', 'Melodic House', 'Afro House', 'Acid House', 'Minimal House',
  'Techno', 'Melodic Techno', 'Hard Techno', 'Minimal Techno', 'Industrial Techno',
  'Drum & Bass', 'Liquid DnB', 'Neurofunk', 'Jump Up',
  'Dubstep', 'Riddim', 'Melodic Dubstep', 'Future Bass',
  'Trap', 'Future Trap', 'Hybrid Trap',
  'Trance', 'Psytrance', 'Progressive Trance', 'Uplifting Trance',
  'Garage', 'UK Garage', 'Speed Garage', 'Bassline',
  'Breakbeat', 'Breaks', 'Big Beat',
  'Disco', 'Nu Disco', 'Disco House', 'Funk',
  'Hardstyle', 'Hardcore', 'Hard Dance',
  'Ambient', 'Downtempo', 'Chillout', 'Lo-Fi',
  'House', 'EDM', 'Dance', 'Electronic',
  'Hip Hop', 'R&B', 'Pop', 'Reggaeton', 'Latin', 'Afrobeats',
  'Jersey Club', 'Baltimore Club', 'Amapiano',
];

// Pick the most specific genre from SoundCloud tags, falling back to the broad genre
function pickBestGenre(meta) {
  const tags = meta.tags || [];
  const scGenre = meta.genre || '';

  // Check tags for a specific sub-genre match (case-insensitive)
  for (const specific of SPECIFIC_GENRES) {
    const lower = specific.toLowerCase();
    for (const tag of tags) {
      if (tag.toLowerCase() === lower) return specific;
    }
  }

  // Check if the broad genre itself is specific enough
  for (const specific of SPECIFIC_GENRES) {
    if (scGenre.toLowerCase() === specific.toLowerCase()) return specific;
  }

  // Fall back to the SoundCloud genre, cleaned up
  if (scGenre && scGenre !== 'none') {
    // Remove "& " patterns like "Dance & EDM" → take the more specific part
    const parts = scGenre.split('&').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      // Return the more specific part (usually the second)
      for (const part of parts) {
        for (const specific of SPECIFIC_GENRES) {
          if (part.toLowerCase() === specific.toLowerCase()) return specific;
        }
      }
    }
    return scGenre;
  }

  return '';
}

// Write genre tag into audio file using ffmpeg
function writeGenreTag(filePath, genre) {
  return new Promise((resolve, reject) => {
    const tmpPath = filePath + '.tmp' + path.extname(filePath);
    execFile('ffmpeg', [
      '-y', '-i', filePath,
      '-metadata', `genre=${genre}`,
      '-codec', 'copy',
      tmpPath
    ], { timeout: 10000 }, (err) => {
      if (err) return reject(err);
      try {
        fs.renameSync(tmpPath, filePath);
        resolve();
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch (x) {}
        reject(e);
      }
    });
  });
}

// Generate a 15-second preview clip from ~35% into the track
function generatePreview(trackPath, previewDir, trackIndex, duration) {
  return new Promise((resolve, reject) => {
    // Start at ~35% of the track, or 30s in, whichever is less
    const startSec = duration > 0
      ? Math.max(0, Math.floor(duration * 0.35))
      : 30;
    const previewPath = path.join(previewDir, `${trackIndex}.mp3`);

    execFile('ffmpeg', [
      '-y',
      '-ss', String(startSec),
      '-i', trackPath,
      '-t', '20',
      '-af', 'afade=t=in:st=0:d=1,afade=t=out:st=18:d=2',
      '-b:a', '128k',
      '-f', 'mp3',
      previewPath
    ], { timeout: 15000 }, (err) => {
      if (err) return reject(err);
      resolve(previewPath);
    });
  });
}

// Serve a preview clip
app.get('/api/preview/:jobId/:trackIndex', (req, res) => {
  const { jobId, trackIndex } = req.params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const idx = parseInt(trackIndex, 10);
  if (isNaN(idx) || idx < 0 || idx > 200) {
    return res.status(400).json({ error: 'Invalid track index' });
  }

  const job = jobs.get(jobId);
  if (!job || !job.previewDir) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const previewPath = path.join(job.previewDir, `${idx}.mp3`);
  if (!fs.existsSync(previewPath)) {
    return res.status(404).json({ error: 'Preview not ready' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(previewPath).pipe(res);
});

// Cancel a job
app.post('/api/cancel', apiLimiter, (req, res) => {
  const { sessionId, jobId } = req.body;

  if (sessionId && activeDownloads.has(sessionId)) {
    const procs = activeDownloads.get(sessionId);
    procs.forEach(p => { if (!p.killed) p.kill(); });
    activeDownloads.delete(sessionId);
  }

  if (jobId && jobs.has(jobId)) {
    const job = jobs.get(jobId);
    job.cancelled = true;
    job.procs.forEach(p => { if (!p.killed) p.kill(); });
  }

  res.json({ ok: true });
});

function getBestThumbnail(track) {
  if (track.thumbnails && track.thumbnails.length > 0) {
    const sorted = [...track.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0].url || track.thumbnail || '';
  }
  return track.thumbnail || '';
}

function cleanup(fileId) {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(fileId));
    files.forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
  } catch (e) {}
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) cleanupDir(fp);
        else fs.unlinkSync(fp);
      });
      fs.rmdirSync(dir);
    }
  } catch (e) {}
}

// 404 handler: unknown API routes get JSON, everything else redirects home.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.redirect('/');
});

analytics.init();

app.listen(PORT, () => {
  console.log(`RipTide running at http://localhost:${PORT}`);
});
