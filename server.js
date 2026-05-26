const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const app = express();
const PORT = 4000;

// Middleware
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

function getYtDlpPath() {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', binName);
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    console.log(`[yt-dlp] Running: ${bin} ${args.join(' ').substring(0, 200)}`);

    execFile(bin, args, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message || 'Unknown yt-dlp error'));
      } else {
        resolve(stdout);
      }
    });
  });
}

function hasCookies() {
  return fs.existsSync(path.join(__dirname, 'cookies.txt'));
}

function cookiesPath() {
  return path.join(__dirname, 'cookies.txt');
}

// ── GET /api/cookies-status ──────────────────────────────────────────────────

app.get('/api/cookies-status', (req, res) => {
  res.json({ loaded: hasCookies() });
});

// ── GET /api/info ────────────────────────────────────────────────────────────

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    // Build args — NO --extractor-args so yt-dlp uses its default client
    // which currently picks android_vr and returns ALL formats (144p–4K)
    const buildInfoArgs = (useCookies) => {
      const a = [
        '--no-check-certificates',
        '--no-warnings',
        '--dump-single-json',
        '--skip-download',
      ];
      if (useCookies) a.push('--cookies', cookiesPath());
      a.push(url);
      return a;
    };

    let stdout;
    const useCookies = hasCookies();

    try {
      stdout = await runYtDlp(buildInfoArgs(useCookies));
    } catch (firstErr) {
      if (useCookies) {
        console.log('[yt-dlp] Info fetch failed with cookies, retrying without...');
        stdout = await runYtDlp(buildInfoArgs(false));
      } else {
        throw firstErr;
      }
    }

    const info = JSON.parse(stdout);

    // ── Build formats list ──
    const seen = new Set();
    const formats = [];

    if (info.formats) {
      // Walk from best → worst so we keep the highest-bitrate entry per resolution
      const reversed = [...info.formats].reverse();

      for (const f of reversed) {
        if (f.vcodec && f.vcodec !== 'none' && f.height) {
          const key = `${f.height}`;
          if (!seen.has(key)) {
            seen.add(key);

            const hasAudio = f.acodec && f.acodec !== 'none';
            const fmtId = hasAudio ? f.format_id : `${f.format_id}+bestaudio`;

            formats.push({
              format_id: fmtId,
              quality: `${f.height}p`,
              height: f.height,
              ext: 'mp4',
              filesize: f.filesize || f.filesize_approx || null,
              type: 'combined',
            });
          }
        }
      }
    }

    formats.sort((a, b) => b.height - a.height);

    // Prepend "Best Quality" and append "Audio Only"
    formats.unshift({
      format_id: 'bestvideo+bestaudio/best',
      quality: 'Best Quality',
      height: 9999,
      ext: 'mp4',
      filesize: null,
      type: 'best',
    });
    formats.push({
      format_id: 'bestaudio',
      quality: 'Audio Only',
      height: 0,
      ext: 'mp3',
      filesize: null,
      type: 'audio',
    });

    // ── Pick a reliable thumbnail ──
    let bestThumbnail = info.thumbnail;
    if (info.thumbnails && info.thumbnails.length > 0) {
      // Prefer maxresdefault JPEG constructed from video id
      const videoId = extractVideoId(url);
      if (videoId) {
        bestThumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      } else {
        const jpgs = info.thumbnails.filter(t => t.url && (t.url.endsWith('.jpg') || t.url.includes('.jpg?')));
        bestThumbnail = jpgs.length > 0
          ? jpgs[jpgs.length - 1].url
          : info.thumbnails[info.thumbnails.length - 1].url;
      }
    }

    return res.json({
      title: info.title,
      thumbnail: bestThumbnail,
      duration: info.duration_string || info.duration,
      channel: info.channel || info.uploader,
      view_count: info.view_count,
      formats,
    });
  } catch (err) {
    console.error('Info fetch failed:', err.message);
    const ytdlpError = err.message.match(/ERROR:.*$/m);
    const userMessage = ytdlpError
      ? ytdlpError[0].replace(/^ERROR:\s*(\[.*?\]\s*\w+:\s*)?/, '')
      : 'Failed to fetch video info.';
    res.status(500).json({ error: userMessage });
  }
});

// ── GET /api/download ────────────────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  try {
    // ── Fetch title for the download filename ──
    const buildInfoArgs = (useCookies) => {
      const a = ['--no-check-certificates', '--no-warnings', '--dump-single-json', '--skip-download'];
      if (useCookies) a.push('--cookies', cookiesPath());
      a.push(url);
      return a;
    };

    let infoStdout;
    const useCookies = hasCookies();

    try {
      infoStdout = await runYtDlp(buildInfoArgs(useCookies));
    } catch (firstErr) {
      if (useCookies) {
        console.log('[yt-dlp] Download-info failed with cookies, retrying without...');
        infoStdout = await runYtDlp(buildInfoArgs(false));
      } else {
        throw firstErr;
      }
    }
    const info = JSON.parse(infoStdout);

    const safeTitle = sanitizeFilename(info.title || 'video');
    const isAudio = format_id === 'bestaudio';
    const ext = isAudio ? 'mp3' : 'mp4';

    const tempFilePath = path.join(os.tmpdir(), `vishants_yt_${Date.now()}.${ext}`);

    // ── Build download args — again NO --extractor-args ──
    const args = ['--no-check-certificates', '--no-warnings'];
    if (useCookies) args.push('--cookies', cookiesPath());
    args.push(url, '-o', tempFilePath);

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

    req.on('close', () => {
      subprocess.kill('SIGTERM');
      setTimeout(() => fs.unlink(tempFilePath, () => {}), 5000);
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
  }
});

// ── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  🚀 Vishant's YT Downloader running at http://localhost:${PORT}\n`);
});
