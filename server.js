const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const archiver = require('archiver');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// --- Security middleware ---

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://i1.sndcdn.com", "https://*.sndcdn.com", "data:"],
      connectSrc: ["'self'"],
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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Resolve yt-dlp: prefer local bin (Heroku), fall back to global (local dev)
const LOCAL_YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const YTDLP = fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp';

const activeDownloads = new Map();
const jobs = new Map();

const MAX_PLAYLIST_TRACKS = 50;
const MAX_CONCURRENT_JOBS = 5;

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 10 * 60 * 1000) {
      if (job.batchDir) cleanupDir(job.batchDir);
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

// Get track/playlist info
app.post('/api/info', apiLimiter, (req, res) => {
  const { url } = req.body;
  if (!url || !isValidSoundCloudUrl(url)) {
    return res.status(400).json({ error: 'Invalid SoundCloud URL' });
  }

  execFile(YTDLP, [
    '--dump-json',
    '--no-warnings',
    '--no-download',
    url
  ], { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch track info. Make sure yt-dlp is installed.' });
    }

    try {
      const lines = stdout.trim().split('\n');
      const entries = lines.map(line => JSON.parse(line));
      const isPlaylist = entries[0].playlist_title || entries[0].playlist || entries.length > 1;

      if (!isPlaylist && entries.length === 1) {
        const t = entries[0];
        return res.json({
          type: 'track',
          title: t.fulltitle || t.title || t.track || 'Unknown',
          artist: t.artist || t.uploader || t.creator || t.channel || 'Unknown',
          album: t.album || '',
          artwork: getBestThumbnail(t),
          duration: t.duration || 0,
          url: t.webpage_url || url
        });
      }

      const playlistTitle = entries[0].playlist_title || entries[0].playlist || 'Playlist';
      const tracks = entries.slice(0, MAX_PLAYLIST_TRACKS).map(t => ({
        title: t.fulltitle || t.title || t.track || 'Unknown',
        artist: t.artist || t.uploader || t.creator || t.channel || 'Unknown',
        album: t.album || '',
        artwork: getBestThumbnail(t),
        duration: t.duration || 0,
        url: t.webpage_url || t.url || ''
      }));

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
  const { url, format = 'mp3', sessionId } = req.body;

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
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Download failed. Make sure yt-dlp and ffmpeg are installed.' });
      }
      return;
    }

    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
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

  const job = {
    status: 'downloading',
    progress: 0,
    currentTrack: 0,
    totalTracks: tracks.length,
    trackStatuses: tracks.map(() => 'pending'),
    batchDir,
    zipPath: null,
    error: null,
    cancelled: false,
    procs: [],
    createdAt: Date.now(),
    playlistName: playlistName || 'playlist',
  };

  jobs.set(jobId, job);
  res.json({ jobId });
  processPlaylist(jobId, tracks, format);
});

async function processPlaylist(jobId, tracks, format) {
  const job = jobs.get(jobId);
  if (!job) return;

  for (let i = 0; i < tracks.length; i++) {
    if (job.cancelled) break;

    job.currentTrack = i;
    job.trackStatuses[i] = 'downloading';
    job.progress = Math.round((i / tracks.length) * 90);

    const track = tracks[i];
    const trackNum = String(i + 1).padStart(2, '0');
    const trackSafeName = (track.title || 'track').replace(/[<>:"/\\|?*]/g, '').substring(0, 80);
    const fileId = randomUUID();
    const outputTemplate = path.join(job.batchDir, `${fileId}.%(ext)s`);

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

    args.push(track.url);

    try {
      await new Promise((resolve, reject) => {
        if (job.cancelled) return reject(new Error('Cancelled'));

        const proc = spawn(YTDLP, args, { timeout: 120000 });
        job.procs.push(proc);

        proc.on('close', (code) => {
          if (job.cancelled) return reject(new Error('Cancelled'));
          if (code !== 0) return reject(new Error(`Track failed`));

          const files = fs.readdirSync(job.batchDir).filter(f => f.startsWith(fileId));
          const audioExts = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus', 'ogg'];
          const audioFile = files.find(f => audioExts.includes(path.extname(f).slice(1)));

          if (audioFile) {
            const ext = path.extname(audioFile).slice(1);
            const newName = `${trackNum} - ${trackSafeName}.${ext}`;
            fs.renameSync(path.join(job.batchDir, audioFile), path.join(job.batchDir, newName));
            job.trackStatuses[i] = 'done';
          } else {
            job.trackStatuses[i] = 'failed';
          }

          const leftover = fs.readdirSync(job.batchDir).filter(f => f.startsWith(fileId));
          leftover.forEach(f => { try { fs.unlinkSync(path.join(job.batchDir, f)); } catch (e) {} });

          resolve();
        });

        proc.on('error', reject);
      });
    } catch (err) {
      if (job.cancelled) break;
      job.trackStatuses[i] = 'failed';
    }
  }

  if (job.cancelled) {
    job.status = 'cancelled';
    cleanupDir(job.batchDir);
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
      archive.directory(job.batchDir, false);
      archive.finalize();
    });

    job.status = 'complete';
    job.progress = 100;
    cleanupDir(job.batchDir);
    job.batchDir = null;
  } catch (err) {
    job.status = 'error';
    job.error = 'Failed to create zip file';
    cleanupDir(job.batchDir);
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
    jobs.delete(jobId);
  });
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'File read error' });
  });
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

app.listen(PORT, () => {
  console.log(`RipTide running at http://localhost:${PORT}`);
});
