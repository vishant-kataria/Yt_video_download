const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 4000;

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const WARP_PROXY = 'socks5://127.0.0.1:1080';

// Piped API fallback instances
let PIPED_INSTANCES = ['https://api.piped.private.coffee'];

// Load Piped instances dynamically
(async function refreshInstances() {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://piped-instances.kavin.rocks/', { signal: controller.signal });
    const list = await res.json();
    const apis = list.filter(i => i.api_url).map(i => i.api_url);
    if (apis.length > 0) {
      PIPED_INSTANCES = ['https://api.piped.private.coffee', ...apis.filter(u => u !== 'https://api.piped.private.coffee')];
      console.log(`  📡 Loaded ${PIPED_INSTANCES.length} Piped API instances`);
    }
  } catch (e) { /* ignore */ }
})();

// Write cookies from env var if present
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
    console.log('✅ Created cookies.txt from environment variable.');
  } catch (err) { /* ignore */ }
}

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

function hasCookiesFile() {
  return fs.existsSync(COOKIES_FILE);
}

function getYtDlpPath() {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', binName);
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Check if WARP proxy is available
async function isWarpAvailable() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(1080, '127.0.0.1');
  });
}

// Build yt-dlp CLI arguments
function getBaseArgs() {
  const args = ['--no-check-certificates', '--no-warnings'];
  if (hasCookiesFile()) args.push('--cookies', COOKIES_FILE);
  return args;
}

// Run yt-dlp with WARP proxy
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    console.log(`[yt-dlp] Running: ${bin} ${args.join(' ').substring(0, 200)}`);

    execFile(bin, args, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message || 'Unknown yt-dlp error'));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Fetch from Piped API (fallback)
async function fetchFromPiped(videoId) {
  const errors = [];
  for (const instance of PIPED_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      console.log(`[Piped] Trying ${instance}/streams/${videoId}`);
      const res = await fetch(`${instance}/streams/${videoId}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) { errors.push(`${instance}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (data.error) { errors.push(`${instance}: ${data.error}`); continue; }
      console.log(`[Piped] ✅ Success from ${instance}`);
      return data;
    } catch (e) { errors.push(`${instance}: ${e.message}`); }
  }
  throw new Error(`All Piped instances failed: ${errors.join(' | ')}`);
}

// ── GET /api/info — Try WARP+yt-dlp first, fall back to Piped ───────────────

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  const videoId = extractVideoId(url);

  // === Strategy 1: yt-dlp through WARP proxy ===
  const warpUp = await isWarpAvailable();
  if (warpUp) {
    try {
      const args = [
        ...getBaseArgs(),
        '--proxy', WARP_PROXY,
        '--dump-single-json',
        '--no-check-formats',
        '--skip-download',
        url,
      ];
      const stdout = await runYtDlp(args);
      const info = JSON.parse(stdout);

      const seen = new Set();
      const formats = [];
      if (info.formats) {
        for (const f of info.formats) {
          if (f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none') {
            const key = `${f.height || 0}`;
            if (!seen.has(key) && f.height) {
              seen.add(key);
              formats.push({ format_id: f.format_id, quality: `${f.height}p`, height: f.height, ext: f.ext || 'mp4', filesize: f.filesize || f.filesize_approx || null, type: 'combined' });
            }
          }
        }
        if (formats.length === 0) {
          for (const f of info.formats) {
            if (f.vcodec && f.vcodec !== 'none' && f.height) {
              const key = `${f.height}`;
              if (!seen.has(key)) {
                seen.add(key);
                formats.push({ format_id: `${f.format_id}+bestaudio`, quality: `${f.height}p`, height: f.height, ext: 'mp4', filesize: f.filesize || f.filesize_approx || null, type: 'combined' });
              }
            }
          }
        }
      }

      formats.sort((a, b) => b.height - a.height);
      formats.unshift({ format_id: 'bestvideo+bestaudio/best', quality: 'Best Quality', height: 9999, ext: 'mp4', filesize: null, type: 'best' });
      formats.push({ format_id: 'bestaudio', quality: 'Audio Only', height: 0, ext: 'mp3', filesize: null, type: 'audio' });

      return res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || info.duration,
        channel: info.channel || info.uploader,
        view_count: info.view_count,
        formats,
        _backend: 'yt-dlp+WARP',
      });
    } catch (err) {
      console.log(`[WARP] yt-dlp failed: ${err.message.substring(0, 100)}, falling back to Piped API`);
    }
  } else {
    console.log('[WARP] Proxy not available, using Piped API');
  }

  // === Strategy 2: Piped API fallback ===
  try {
    const data = await fetchFromPiped(videoId);
    const seen = new Set();
    const formats = [];

    if (data.videoStreams) {
      for (const s of data.videoStreams) {
        const height = parseInt(s.quality) || 0;
        if (!height) continue;
        if (seen.has(`${height}`)) continue;
        seen.add(`${height}`);
        formats.push({
          format_id: s.videoOnly ? `piped_merge:${height}` : `piped_direct:${s.url}`,
          quality: `${height}p`, height, ext: 'mp4',
          filesize: s.contentLength ? parseInt(s.contentLength) : null,
          type: 'combined',
        });
      }
    }

    formats.sort((a, b) => b.height - a.height);
    formats.unshift({ format_id: 'piped_best', quality: 'Best Quality', height: 9999, ext: 'mp4', filesize: null, type: 'best' });
    formats.push({ format_id: 'piped_audio', quality: 'Audio Only', height: 0, ext: 'mp3', filesize: null, type: 'audio' });

    return res.json({
      title: data.title || 'Untitled',
      thumbnail: data.thumbnailUrl || '',
      duration: formatDuration(data.duration),
      channel: data.uploader || data.uploaderName || 'Unknown',
      view_count: data.views || 0,
      formats,
      _backend: 'Piped API',
      _pipedData: { videoStreams: data.videoStreams, audioStreams: data.audioStreams },
    });
  } catch (err) {
    console.error('Both backends failed:', err.message);
    res.status(500).json({ error: `Failed to fetch video info. Please try again later.` });
  }
});

// ── GET /api/download ────────────────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });

  const videoId = extractVideoId(url);

  // === Piped-based download ===
  if (format_id?.startsWith('piped_')) {
    try {
      const data = await fetchFromPiped(videoId);
      const safeTitle = sanitizeFilename(data.title || 'video');

      if (format_id === 'piped_audio') {
        const audioStream = data.audioStreams?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (!audioStream) return res.status(500).json({ error: 'No audio stream.' });

        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp3"; filename*=UTF-8''${encodeURIComponent(safeTitle + '.mp3')}`);
        res.setHeader('Content-Type', 'audio/mpeg');
        const ffmpeg = spawn('ffmpeg', ['-i', audioStream.url, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-f', 'mp3', 'pipe:1']);
        ffmpeg.stdout.pipe(res);
        ffmpeg.stderr.on('data', () => {});
        req.on('close', () => ffmpeg.kill('SIGTERM'));
        return;
      }

      // Video download
      let videoStream;
      const sorted = [...(data.videoStreams || [])].sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

      if (format_id === 'piped_best') {
        videoStream = sorted[0];
      } else if (format_id.startsWith('piped_merge:')) {
        const h = parseInt(format_id.replace('piped_merge:', ''));
        videoStream = sorted.find(s => parseInt(s.quality) === h) || sorted[0];
      } else if (format_id.startsWith('piped_direct:')) {
        const directUrl = format_id.replace('piped_direct:', '');
        videoStream = { url: directUrl, videoOnly: false };
      }

      if (!videoStream) return res.status(500).json({ error: 'No video stream.' });

      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"; filename*=UTF-8''${encodeURIComponent(safeTitle + '.mp4')}`);
      res.setHeader('Content-Type', 'video/mp4');

      const audioStream = data.audioStreams?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      let ffmpegArgs;

      if (videoStream.videoOnly && audioStream) {
        ffmpegArgs = ['-i', videoStream.url, '-i', audioStream.url, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1'];
      } else {
        ffmpegArgs = ['-i', videoStream.url, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1'];
      }

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      ffmpeg.stdout.pipe(res);
      ffmpeg.stderr.on('data', () => {});
      ffmpeg.on('close', (code) => { if (code !== 0) console.error(`FFmpeg exited ${code}`); });
      req.on('close', () => ffmpeg.kill('SIGTERM'));
      return;
    } catch (err) {
      console.error('Piped download error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
      return;
    }
  }

  // === yt-dlp based download (via WARP) ===
  try {
    const infoArgs = [...getBaseArgs(), '--proxy', WARP_PROXY, '--dump-single-json', '--no-check-formats', '--skip-download', url];
    const infoStdout = await runYtDlp(infoArgs);
    const info = JSON.parse(infoStdout);

    const safeTitle = sanitizeFilename(info.title || 'video');
    const isAudio = format_id === 'bestaudio';
    const ext = isAudio ? 'mp3' : 'mp4';

    const tempFilePath = path.join(os.tmpdir(), `tubegrab_${Date.now()}.${ext}`);
    const args = [...getBaseArgs(), '--proxy', WARP_PROXY, url, '-o', tempFilePath];

    if (isAudio) {
      args.push('-f', 'bestaudio', '-x', '--audio-format', 'mp3');
    } else if (format_id) {
      args.push('-f', format_id, '--merge-output-format', 'mp4');
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    }

    const ytdlpBin = getYtDlpPath();
    const subprocess = spawn(ytdlpBin, args);
    let stderrData = '';
    subprocess.stderr?.on('data', (c) => { stderrData += c.toString(); });

    subprocess.on('close', (code) => {
      if (code === 0) {
        const encodedTitle = encodeURIComponent(`${safeTitle}.${ext}`);
        res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"; filename*=UTF-8''${encodedTitle}`);
        res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
        const fileStream = fs.createReadStream(tempFilePath);
        fileStream.pipe(res);
        fileStream.on('close', () => fs.unlink(tempFilePath, () => {}));
      } else {
        console.error('yt-dlp exit', code, stderrData.substring(0, 200));
        if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
        fs.unlink(tempFilePath, () => {});
      }
    });

    subprocess.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
    });

    req.on('close', () => { subprocess.kill('SIGTERM'); setTimeout(() => fs.unlink(tempFilePath, () => {}), 5000); });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
  }
});

// ── GET /api/cookies-status ──────────────────────────────────────────────────

app.get('/api/cookies-status', async (req, res) => {
  const warp = await isWarpAvailable();
  res.json({ hasCookies: warp || hasCookiesFile(), warpActive: warp });
});

// ── GET /api/debug ───────────────────────────────────────────────────────────

app.get('/api/debug', async (req, res) => {
  const results = {
    platform: process.platform,
    nodeVersion: process.version,
    warpAvailable: await isWarpAvailable(),
    ytdlpExists: fs.existsSync(getYtDlpPath()),
    cookiesExists: hasCookiesFile(),
    pipedInstances: PIPED_INSTANCES.length,
  };

  // Test yt-dlp version
  try {
    const v = await runYtDlp(['--version']);
    results.ytdlpVersion = v.trim();
  } catch (e) { results.ytdlpVersion = `ERROR: ${e.message.substring(0, 100)}`; }

  // Test WARP proxy with yt-dlp
  if (results.warpAvailable) {
    try {
      const args = [...getBaseArgs(), '--proxy', WARP_PROXY, '--dump-single-json', '--no-check-formats', '--skip-download', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'];
      const stdout = await runYtDlp(args);
      const info = JSON.parse(stdout);
      results.warpTest = { success: true, title: info.title, formats: info.formats?.length || 0 };
    } catch (e) { results.warpTest = { success: false, error: e.message.substring(0, 300) }; }
  }

  // Test Piped API
  try {
    const data = await fetchFromPiped('jNQXAC9IVRw');
    results.pipedTest = { success: true, title: data.title, videoStreams: data.videoStreams?.length || 0 };
  } catch (e) { results.pipedTest = { success: false, error: e.message.substring(0, 300) }; }

  res.json(results);
});

// ── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  🚀 YouTube Downloader server running at:`);
  console.log(`     http://localhost:${PORT}`);

  const warp = await isWarpAvailable();
  if (warp) {
    console.log(`  🌐 Cloudflare WARP proxy: ✅ Active`);
  } else {
    console.log(`  🌐 Cloudflare WARP proxy: ❌ Not available (using Piped API fallback)`);
  }
  console.log('');
});
