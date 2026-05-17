const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4000;

// Piped API instances — dynamically updated from official registry
let PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
];

// Fetch additional instances from the official Piped registry on startup
(async function refreshInstances() {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://piped-instances.kavin.rocks/', { signal: controller.signal });
    const list = await res.json();
    const apis = list.filter(i => i.api_url).map(i => i.api_url);
    if (apis.length > 0) {
      // Put the known-working one first, then add others
      PIPED_INSTANCES = ['https://api.piped.private.coffee', ...apis.filter(u => u !== 'https://api.piped.private.coffee')];
      console.log(`  📡 Loaded ${PIPED_INSTANCES.length} Piped instances`);
    }
  } catch (e) {
    console.log('  ⚠️  Could not refresh Piped instances, using defaults');
  }
})();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function isValidYouTubeUrl(url) {
  return extractVideoId(url) !== null;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_').substring(0, 100);
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Fetch from Piped API with automatic fallback across instances
async function fetchFromPiped(videoId) {
  const errors = [];

  for (const instance of PIPED_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      console.log(`[Piped] Trying ${instance}/streams/${videoId}`);
      const res = await fetch(`${instance}/streams/${videoId}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        errors.push(`${instance}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (data.error) {
        errors.push(`${instance}: ${data.error}`);
        continue;
      }

      console.log(`[Piped] ✅ Success from ${instance} — "${data.title}"`);
      data._instance = instance;
      return data;
    } catch (e) {
      errors.push(`${instance}: ${e.message}`);
      continue;
    }
  }

  throw new Error(`All Piped instances failed: ${errors.join(' | ')}`);
}

// ── GET /api/info ────────────────────────────────────────────────────────────

app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const videoId = extractVideoId(url);
    const data = await fetchFromPiped(videoId);

    // Build format list from Piped streams
    const seen = new Set();
    const formats = [];

    // Video streams
    if (data.videoStreams) {
      for (const s of data.videoStreams) {
        const height = parseInt(s.quality) || 0;
        if (!height) continue;

        const key = `${height}`;
        if (seen.has(key)) continue;
        seen.add(key);

        formats.push({
          format_id: s.videoOnly ? `merge:${height}` : `direct:${height}`,
          quality: `${height}p`,
          height,
          ext: 'mp4',
          filesize: s.contentLength ? parseInt(s.contentLength) : null,
          type: 'combined',
        });
      }
    }

    formats.sort((a, b) => b.height - a.height);

    // "Best Quality" convenience option
    formats.unshift({
      format_id: 'best',
      quality: 'Best Quality',
      height: 9999,
      ext: 'mp4',
      filesize: null,
      type: 'best',
    });

    // Audio-only option
    formats.push({
      format_id: 'audio',
      quality: 'Audio Only',
      height: 0,
      ext: 'mp3',
      filesize: null,
      type: 'audio',
    });

    res.json({
      title: data.title || 'Untitled',
      thumbnail: data.thumbnailUrl || '',
      duration: formatDuration(data.duration),
      channel: data.uploader || data.uploaderName || 'Unknown',
      view_count: data.views || 0,
      formats,
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({
      error: `Failed to fetch video info: ${err.message.substring(0, 300)}`,
    });
  }
});

// ── GET /api/download ────────────────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url, format_id } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const videoId = extractVideoId(url);
    const data = await fetchFromPiped(videoId);
    const safeTitle = sanitizeFilename(data.title || 'video');

    // ── Audio-only download ──
    if (format_id === 'audio') {
      const audioStream = data.audioStreams
        ?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (!audioStream) {
        return res.status(500).json({ error: 'No audio stream available.' });
      }

      const encodedTitle = encodeURIComponent(`${safeTitle}.mp3`);
      res.setHeader('Content-Disposition', `attachment; filename="audio.mp3"; filename*=UTF-8''${encodedTitle}`);
      res.setHeader('Content-Type', 'audio/mpeg');

      const ffmpeg = spawn('ffmpeg', [
        '-i', audioStream.url,
        '-vn', '-acodec', 'libmp3lame', '-ab', '192k',
        '-f', 'mp3',
        'pipe:1',
      ]);

      ffmpeg.stdout.pipe(res);
      ffmpeg.stderr.on('data', (d) => { /* suppress ffmpeg progress logs */ });
      ffmpeg.on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Audio conversion failed.' });
      });
      req.on('close', () => ffmpeg.kill('SIGTERM'));
      return;
    }

    // ── Video download ──
    let targetHeight = 0;
    let needsMerge = false;

    if (format_id === 'best') {
      targetHeight = 99999;
      needsMerge = true;
    } else if (format_id?.startsWith('merge:')) {
      targetHeight = parseInt(format_id.replace('merge:', ''));
      needsMerge = true;
    } else if (format_id?.startsWith('direct:')) {
      targetHeight = parseInt(format_id.replace('direct:', ''));
      needsMerge = false;
    }

    // Find the best matching video stream
    let videoStream;
    if (data.videoStreams) {
      const sorted = [...data.videoStreams].sort((a, b) => {
        return (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0);
      });

      if (targetHeight >= 99999) {
        videoStream = sorted[0];
      } else {
        videoStream = sorted.find(s => (parseInt(s.quality) || 0) === targetHeight) || sorted[0];
      }
    }

    if (!videoStream) {
      return res.status(500).json({ error: 'No video stream available.' });
    }

    const encodedTitle = encodeURIComponent(`${safeTitle}.mp4`);
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"; filename*=UTF-8''${encodedTitle}`);
    res.setHeader('Content-Type', 'video/mp4');

    let ffmpegArgs;

    if (videoStream.videoOnly || needsMerge) {
      // Need to merge video + audio
      const audioStream = data.audioStreams
        ?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (audioStream) {
        ffmpegArgs = [
          '-i', videoStream.url,
          '-i', audioStream.url,
          '-c', 'copy',
          '-movflags', 'frag_keyframe+empty_moov+faststart',
          '-f', 'mp4',
          'pipe:1',
        ];
      } else {
        ffmpegArgs = [
          '-i', videoStream.url,
          '-c', 'copy',
          '-movflags', 'frag_keyframe+empty_moov+faststart',
          '-f', 'mp4',
          'pipe:1',
        ];
      }
    } else {
      // Combined stream — just pipe through
      ffmpegArgs = [
        '-i', videoStream.url,
        '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4',
        'pipe:1',
      ];
    }

    console.log(`[Download] Starting FFmpeg for "${data.title}" at ${videoStream.quality}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', (d) => { /* suppress ffmpeg progress logs */ });
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Video processing failed.' });
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0) console.error(`FFmpeg exited with code ${code}`);
    });

    req.on('close', () => ffmpeg.kill('SIGTERM'));
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. Please try again.' });
    }
  }
});

// ── GET /api/cookies-status ──────────────────────────────────────────────────

app.get('/api/cookies-status', (req, res) => {
  // Piped API doesn't need cookies — always show as ready
  res.json({ hasCookies: true });
});

// ── GET /api/debug — Diagnostic endpoint ─────────────────────────────────────

app.get('/api/debug', async (req, res) => {
  const results = {
    platform: process.platform,
    nodeVersion: process.version,
    backend: 'Piped API',
    instances: [],
  };

  const testVideoId = 'jNQXAC9IVRw'; // "Me at the zoo"

  for (const instance of PIPED_INSTANCES) {
    const test = { instance, success: false };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(`${instance}/streams/${testVideoId}`, { signal: controller.signal });
      clearTimeout(timeout);
      const d = await r.json();
      test.success = !d.error;
      test.title = d.title || d.error || 'unknown';
      test.videoStreams = d.videoStreams?.length || 0;
      test.audioStreams = d.audioStreams?.length || 0;
    } catch (e) {
      test.error = e.message;
    }
    results.instances.push(test);
  }

  res.json(results);
});

// ── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  🚀 YouTube Downloader server running at:`);
  console.log(`     http://localhost:${PORT}`);
  console.log(`  🔧 Backend: Piped API (no yt-dlp, no cookies needed)`);
  console.log('');
});
