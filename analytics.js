// analytics.js — privacy-friendly usage analytics backed by Postgres (Neon).
//
// Degrades gracefully: if DATABASE_URL is not set, every function becomes a
// no-op so the app runs exactly as before (e.g. local dev without a database).
//
// What we store:
//   - visits (page loads), downloads (single + playlist), per-track rows
//   - a hashed anonymous visitor id (sha256 of IP + User-Agent + salt) — no raw IP/PII
//   - rough geo (country/region/city) from an offline IP database
//   - device / browser / OS parsed from the User-Agent
//
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const SALT = process.env.ANALYTICS_SALT || 'riptide-analytics';
const enabled = !!DATABASE_URL;

let pool = null;
let geoip = null;
let ready = false;

// Lazily require optional deps so the app still boots if they aren't installed.
if (enabled) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Neon and most hosted Postgres require SSL; allow self-signed chains.
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', (err) => console.error('[analytics] pool error:', err.message));
  } catch (e) {
    console.error('[analytics] "pg" not installed — analytics disabled. Run: npm install pg');
  }
  try {
    geoip = require('geoip-lite');
  } catch (e) {
    console.warn('[analytics] "geoip-lite" not installed — geo data disabled. Run: npm install geoip-lite');
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,            -- 'visit' | 'single' | 'playlist'
  format TEXT,
  status TEXT,                   -- 'success' | 'failed' | 'started' | 'complete' | 'error'
  track_count INT DEFAULT 0,
  playlist_name TEXT,
  url TEXT,
  title TEXT,
  artist TEXT,
  visitor_id TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  device TEXT,
  browser TEXT,
  os TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);

CREATE TABLE IF NOT EXISTS tracks (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT,                     -- 'single' | 'playlist'
  format TEXT,
  url TEXT,
  title TEXT,
  artist TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
`;

async function init() {
  if (!enabled) {
    console.log('[analytics] DATABASE_URL not set — analytics disabled (app runs normally).');
    return;
  }
  if (!pool) return;
  try {
    await pool.query(SCHEMA);
    ready = true;
    console.log('[analytics] connected to Postgres, schema ready.');
  } catch (e) {
    console.error('[analytics] failed to init schema:', e.message);
  }
}

// --- User-Agent parsing (lightweight, no dependency) ---

function parseUA(ua = '') {
  ua = ua || '';
  let device = 'desktop';
  if (/\b(iPad|Tablet)\b/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) device = 'mobile';

  let browser = 'Other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';

  let os = 'Other';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { device, browser, os };
}

// Pull anonymized client metadata from an Express request.
function clientMeta(req) {
  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || req.socket?.remoteAddress || '';
  const visitorId = crypto.createHash('sha256').update(ip + '|' + ua + '|' + SALT).digest('hex').slice(0, 16);

  let geo = {};
  if (geoip && ip) {
    try {
      const cleanIp = ip.replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6 prefix
      const g = geoip.lookup(cleanIp);
      if (g) geo = { country: g.country, region: g.region, city: g.city };
    } catch (e) {}
  }

  const { device, browser, os } = parseUA(ua);
  return {
    visitorId,
    country: geo.country || null,
    region: geo.region || null,
    city: geo.city || null,
    device, browser, os,
  };
}

// --- Logging (all fire-and-forget; never throw into the request path) ---

function logVisit(req) {
  if (!ready) return;
  const m = clientMeta(req);
  pool.query(
    `INSERT INTO events (kind, visitor_id, country, region, city, device, browser, os)
     VALUES ('visit',$1,$2,$3,$4,$5,$6,$7)`,
    [m.visitorId, m.country, m.region, m.city, m.device, m.browser, m.os]
  ).catch((e) => console.error('[analytics] logVisit:', e.message));
}

// Log a download event plus one row per track. Returns the event id (or null).
// kind: 'single' | 'playlist'
// tracks: [{ url, title, artist }]
async function logDownload(req, { kind, format, status, tracks = [], playlistName = null, url = null }) {
  if (!ready) return null;
  const m = clientMeta(req);
  const first = tracks[0] || {};
  try {
    const { rows } = await pool.query(
      `INSERT INTO events
         (kind, format, status, track_count, playlist_name, url, title, artist,
          visitor_id, country, region, city, device, browser, os)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [kind, format, status, tracks.length,
       playlistName, url || first.url || null, first.title || null, first.artist || null,
       m.visitorId, m.country, m.region, m.city, m.device, m.browser, m.os]
    );
    const eventId = rows[0].id;

    if (tracks.length) {
      // Bulk insert track rows.
      const values = [];
      const params = [];
      tracks.forEach((t, i) => {
        const b = i * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(eventId, kind, format, t.url || null, t.title || null, t.artist || null);
      });
      await pool.query(
        `INSERT INTO tracks (event_id, kind, format, url, title, artist) VALUES ${values.join(',')}`,
        params
      );
    }
    return eventId;
  } catch (e) {
    console.error('[analytics] logDownload:', e.message);
    return null;
  }
}

function updateStatus(eventId, status, trackCount) {
  if (!ready || !eventId) return;
  const sets = ['status = $2'];
  const params = [eventId, status];
  if (typeof trackCount === 'number') { sets.push('track_count = $3'); params.push(trackCount); }
  pool.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, params)
    .catch((e) => console.error('[analytics] updateStatus:', e.message));
}

// --- Dashboard aggregates ---

async function getStats() {
  if (!ready) return { enabled: false };

  const q = (text, params) => pool.query(text, params).then((r) => r.rows);
  const dl = `kind IN ('single','playlist')`;

  const [
    totals, daily, formats, kinds, topTracks, topArtists,
    countries, devices, browsers, recent,
  ] = await Promise.all([
    q(`SELECT
         (SELECT COUNT(*) FROM tracks) AS total_downloads,
         (SELECT COUNT(*) FROM events WHERE ${dl}) AS download_events,
         (SELECT COUNT(*) FROM events WHERE kind='single') AS single_count,
         (SELECT COUNT(*) FROM events WHERE kind='playlist') AS playlist_count,
         (SELECT COUNT(*) FROM events WHERE kind='visit') AS total_visits,
         (SELECT COUNT(DISTINCT visitor_id) FROM events WHERE visitor_id IS NOT NULL) AS unique_visitors,
         (SELECT COUNT(*) FROM tracks WHERE created_at >= now() - interval '1 day') AS downloads_24h,
         (SELECT COUNT(*) FROM tracks WHERE created_at >= now() - interval '7 days') AS downloads_7d,
         (SELECT COUNT(*) FROM events WHERE ${dl} AND status IN ('success','complete')) AS ok_count,
         (SELECT COUNT(*) FROM events WHERE ${dl} AND status IN ('failed','error')) AS fail_count`),
    q(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*) AS n
         FROM tracks WHERE created_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`),
    q(`SELECT COALESCE(format,'?') AS label, COUNT(*) AS n FROM tracks GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT kind AS label, COUNT(*) AS n FROM events WHERE ${dl} GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT COALESCE(NULLIF(title,''),'(unknown)') AS title, COALESCE(artist,'') AS artist, COUNT(*) AS n
         FROM tracks GROUP BY 1,2 ORDER BY n DESC LIMIT 15`),
    q(`SELECT COALESCE(NULLIF(artist,''),'(unknown)') AS artist, COUNT(*) AS n
         FROM tracks GROUP BY 1 ORDER BY n DESC LIMIT 15`),
    q(`SELECT COALESCE(country,'??') AS label, COUNT(*) AS n FROM events WHERE ${dl} GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    q(`SELECT COALESCE(device,'?') AS label, COUNT(*) AS n FROM events WHERE ${dl} GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT COALESCE(browser,'?') AS label, COUNT(*) AS n FROM events WHERE ${dl} GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT to_char(created_at,'YYYY-MM-DD HH24:MI') AS at, kind, format, status, track_count,
              COALESCE(title,'') AS title, COALESCE(artist,'') AS artist,
              COALESCE(playlist_name,'') AS playlist_name,
              COALESCE(country,'') AS country, COALESCE(device,'') AS device
         FROM events WHERE ${dl} ORDER BY created_at DESC LIMIT 30`),
  ]);

  return {
    enabled: true,
    totals: totals[0],
    daily, formats, kinds, topTracks, topArtists, countries, devices, browsers, recent,
  };
}

module.exports = { init, logVisit, logDownload, updateStatus, getStats, isEnabled: () => enabled };
