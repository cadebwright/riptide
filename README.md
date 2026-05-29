# RipTide

A web app for downloading and converting SoundCloud tracks and playlists to MP3, WAV, AAC, or FLAC at 320kbps.

Features:
- Download individual tracks or full playlists (up to 50 tracks)
- Multiple audio formats (MP3, WAV, AAC, FLAC)
- Real-time progress tracking for batch downloads
- Audio preview with waveform visualization
- Genre tagging for DJ software (Rekordbox, etc.)
- Export playlists as ZIP
- Installable as a PWA

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)

### Install yt-dlp and FFmpeg

**macOS:**
```bash
brew install yt-dlp ffmpeg
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install yt-dlp ffmpeg
```

**Windows:**
```bash
choco install yt-dlp ffmpeg
```

## Installation

```bash
git clone https://github.com/cadebwright/riptide.git
cd riptide
npm install
```

## Usage

**Development** (auto-restarts on file changes):
```bash
npm run dev
```

**Production:**
```bash
npm start
```

The app runs at `http://localhost:3000`.

## Analytics (optional)

RipTide can log usage to a Postgres database and serve a private dashboard at `/stats`.
It tracks page visits, downloads (single + playlist), formats, success/failure, the
track/playlist URLs, approximate geo (country), and device/browser — using a hashed
anonymous visitor ID (no raw IPs or personal data are stored).

If `DATABASE_URL` is not set, analytics is silently disabled and the app runs normally.

**Setup:**

1. Create a free Postgres database at [Neon](https://neon.tech) and copy its connection string.
2. Copy `.env.example` to `.env` (or set these vars in your host's config):
   ```bash
   DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
   ADMIN_PASSWORD=choose-a-strong-password
   ANALYTICS_SALT=any-random-string
   ```
3. Start the app — the schema is created automatically on first boot.
4. Visit `/stats`. You'll be redirected to a `/stats/login` page; enter your `ADMIN_PASSWORD`.

The dashboard is locked until `ADMIN_PASSWORD` is set. Login uses a cookie session
(valid 7 days), not the browser's basic-auth popup.

## Bot protection (optional)

The admin login page is protected by [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)
when configured. The public download page is intentionally **not** gated.

Add both keys to `.env` (and add your domain — plus `localhost` for local testing —
to the widget's allowed hostnames in the Cloudflare dashboard):

```bash
TURNSTILE_SITE_KEY=0x...
TURNSTILE_SECRET_KEY=0x...
```

Without both keys, the login page works with the password alone.

## License

[GPL-3.0](LICENSE)
