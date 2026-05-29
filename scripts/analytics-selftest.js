// Quick end-to-end check of the analytics module against a real database.
// Usage:  DATABASE_URL='postgres://...' node scripts/analytics-selftest.js
//
// It inits the schema, writes a fake visit + single download + playlist,
// then prints the dashboard aggregates. Safe to run repeatedly.
try { require('dotenv').config(); } catch (e) {}
const analytics = require('../analytics');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run: DATABASE_URL="postgres://..." node scripts/analytics-selftest.js');
  process.exit(1);
}

// Minimal fake Express request.
const fakeReq = {
  ip: '8.8.8.8',
  socket: { remoteAddress: '8.8.8.8' },
  headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
};

(async () => {
  await analytics.init();

  console.log('Writing test events…');
  analytics.logVisit(fakeReq);
  await analytics.logDownload(fakeReq, {
    kind: 'single', format: 'mp3', status: 'success',
    tracks: [{ url: 'https://soundcloud.com/test/track', title: 'Selftest Track', artist: 'Selftest Artist' }],
  });
  const id = await analytics.logDownload(fakeReq, {
    kind: 'playlist', format: 'wav', status: 'started', playlistName: 'Selftest Playlist',
    tracks: [
      { url: 'https://soundcloud.com/test/a', title: 'A', artist: 'Artist A' },
      { url: 'https://soundcloud.com/test/b', title: 'B', artist: 'Artist B' },
    ],
  });
  analytics.updateStatus(id, 'complete', 2);

  // small delay to let fire-and-forget inserts land
  await new Promise(r => setTimeout(r, 500));

  console.log('\nDashboard stats:');
  const stats = await analytics.getStats();
  console.log(JSON.stringify(stats.totals, null, 2));
  console.log('formats:', stats.formats);
  console.log('topTracks:', stats.topTracks.slice(0, 3));
  console.log('countries:', stats.countries);
  console.log('\n✅ Analytics is working.');
  process.exit(0);
})().catch((e) => { console.error('❌ Self-test failed:', e); process.exit(1); });
