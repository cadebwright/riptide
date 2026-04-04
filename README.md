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

## License

[GPL-3.0](LICENSE)
