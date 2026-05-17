const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 4000;

// Path to optional cookies file (Netscape format)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

// Safely handle cookies via environment variable
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
    console.log('✅ Created cookies.txt from environment variable.');
  } catch (err) {
    console.error('❌ Failed to write cookies from environment variable:', err);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_').substring(0, 100);
}

function isValidYouTubeUrl(url) {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)/;
  return pattern.test(url);
}

function hasCookiesFile() {
  return fs.existsSync(COOKIES_FILE);
}

// Determine the correct yt-dlp binary path based on platform
function getYtDlpPath() {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', binName);
}

// Build common yt-dlp options, with cookies if available
function getBaseOptions() {
  const opts = {
    noCheckCertificates: true,
    noWarnings: true,
  };
  // Enable Node.js as JS runtime for YouTube extraction
  if (process.platform !== 'win32') {
    opts.jsRuntimes = 'nodejs';
  }
  if (hasCookiesFile()) {
    opts.cookies = COOKIES_FILE;
  }
  return opts;
}

// ── GET /api/info ────────────────────────────────────────────────────────────

app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const opts = {
      ...getBaseOptions(),
      dumpSingleJson: true,
    };

    const info = await youtubedl(url, opts);

    // Build a clean list of downloadable formats
    const seen = new Set();
    const formats = [];

    if (info.formats) {
      for (const f of info.formats) {
        if (f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none') {
          const key = `${f.height || 0}-combined`;
          if (!seen.has(key) && f.height) {
            seen.add(key);
            formats.push({
              format_id: f.format_id,
              quality: `${f.height}p`,
              height: f.height,
              ext: f.ext || 'mp4',
              filesize: f.filesize || f.filesize_approx || null,
              type: 'combined',
            });
          }
        }
      }
    }

    formats.sort((a, b) => b.height - a.height);

    // "Best" convenience option
    formats.unshift({
      format_id: 'bestvideo+bestaudio/best',
      quality: 'Best Quality',
      height: 9999,
      ext: 'mp4',
      filesize: null,
      type: 'best',
    });

    // Audio-only option
    formats.push({
      format_id: 'bestaudio',
      quality: 'Audio Only',
      height: 0,
      ext: 'mp3',
      filesize: null,
      type: 'audio',
    });

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration_string || info.duration,
      channel: info.channel || info.uploader,
      view_count: info.view_count,
      formats,
    });
  } catch (err) {
    const msg = (err.message || err.stderr || '').toString();
    console.error('Info error:', msg);

    if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('cookies')) {
      if (hasCookiesFile()) {
        // Cookies exist but YouTube still blocks — data center IP issue
        res.status(403).json({
          error: 'YouTube is blocking requests from this server\'s IP address even with cookies. Try refreshing your cookies (they may have expired) or try a different video.',
          needsCookies: false,
        });
      } else {
        res.status(403).json({
          error: 'YouTube requires authentication. Please export your browser cookies to a cookies.txt file and place it in the project root. See the guide below the search bar.',
          needsCookies: true,
        });
      }
    } else if (msg.includes('Requested format')) {
      res.status(500).json({
        error: 'Could not find a downloadable format for this video. The video may be region-restricted or require a different format.',
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch video info. The video may be private, age-restricted, or the URL is invalid.',
      });
    }
  }
});

// ── GET /api/download ────────────────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url, format_id } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const opts = { ...getBaseOptions(), dumpSingleJson: true };
    const info = await youtubedl(url, opts);

    const safeTitle = sanitizeFilename(info.title || 'video');
    const isAudio = format_id === 'bestaudio';
    const ext = isAudio ? 'mp3' : 'mp4';

    const tempFilePath = path.join(os.tmpdir(), `tubegrab_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`);
    const args = [url, '-o', tempFilePath];

    if (isAudio) {
      args.push('-f', 'bestaudio', '-x', '--audio-format', 'mp3');
    } else if (format_id) {
      args.push('-f', format_id, '--merge-output-format', 'mp4');
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    }

    args.push('--no-check-certificates', '--no-warnings');

    // Enable Node.js as JS runtime on Linux
    if (process.platform !== 'win32') {
      args.push('--js-runtimes', 'nodejs');
    }

    if (hasCookiesFile()) {
      args.push('--cookies', COOKIES_FILE);
    }

    const ytdlpBin = getYtDlpPath();
    const subprocess = require('child_process').spawn(ytdlpBin, args);

    let stderrData = '';
    if (subprocess.stderr) {
      subprocess.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });
    }

    subprocess.on('error', (err) => {
      console.error('Spawn error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed. Please try again.' });
      }
    });

    subprocess.on('close', (code) => {
      if (code === 0) {
        // Set response headers for file download
        const encodedTitle = encodeURIComponent(`${safeTitle}.${ext}`);
        res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"; filename*=UTF-8''${encodedTitle}`);
        res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

        const fileStream = fs.createReadStream(tempFilePath);
        fileStream.pipe(res);
        
        fileStream.on('close', () => {
          fs.unlink(tempFilePath, (err) => {
            if (err && err.code !== 'ENOENT') console.error('Error deleting temp file:', err);
          });
        });
      } else {
        console.error('yt-dlp exited with code', code, stderrData);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download process failed.' });
        }
        fs.unlink(tempFilePath, () => {}); // clean up partial file if any
      }
    });

    req.on('close', () => {
      subprocess.kill('SIGTERM');
      // Clean up temp file if client disconnects early
      setTimeout(() => {
        fs.unlink(tempFilePath, () => {});
      }, 5000);
    });
  } catch (err) {
    console.error('Download error:', err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. Please try again.' });
    }
  }
});

// ── GET /api/cookies-status ──────────────────────────────────────────────────

app.get('/api/cookies-status', (req, res) => {
  res.json({ hasCookies: hasCookiesFile() });
});

// ── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  🚀 YouTube Downloader server running at:`);
  console.log(`     http://localhost:${PORT}`);
  if (hasCookiesFile()) {
    console.log(`  🍪 cookies.txt found — authentication enabled.`);
  } else {
    console.log(`  ⚠️  No cookies.txt found — some videos may require it.`);
    console.log(`     Place a Netscape-format cookies.txt in the project root.`);
  }
  console.log('');
});
