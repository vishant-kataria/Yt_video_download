const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

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

// Build common yt-dlp CLI arguments
function getBaseArgs() {
  const args = ['--no-check-certificates', '--no-warnings'];
  // Enable Node.js as JS runtime for YouTube extraction on Linux
  if (process.platform !== 'win32') {
    args.push('--js-runtimes', 'nodejs');
  }
  if (hasCookiesFile()) {
    args.push('--cookies', COOKIES_FILE);
  }
  return args;
}

// Run yt-dlp and return stdout as a promise
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    console.log(`[yt-dlp] Running: ${bin} ${args.join(' ')}`);

    execFile(bin, args, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const errorMsg = stderr || err.message || 'Unknown yt-dlp error';
        console.error(`[yt-dlp] Error: ${errorMsg}`);
        reject(new Error(errorMsg));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── GET /api/info ────────────────────────────────────────────────────────────

app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const args = [
      ...getBaseArgs(),
      '--dump-single-json',
      '--no-check-formats',
      '--skip-download',
      url,
    ];

    const stdout = await runYtDlp(args);
    const info = JSON.parse(stdout);

    // Build a clean list of downloadable formats
    const seen = new Set();
    const formats = [];

    if (info.formats) {
      // First try combined formats (video+audio in one stream)
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

      // If no combined formats, show video-only formats (will be merged with audio on download)
      if (formats.length === 0) {
        for (const f of info.formats) {
          if (f.vcodec && f.vcodec !== 'none' && f.height) {
            const key = `${f.height}-video`;
            if (!seen.has(key)) {
              seen.add(key);
              formats.push({
                format_id: `${f.format_id}+bestaudio`,
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
    const msg = (err.message || '').toString();
    console.error('Info error:', msg);

    if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('cookies')) {
      if (hasCookiesFile()) {
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
        error: `Failed to fetch video info: ${msg.substring(0, 200)}`,
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
    // First get video title for the filename
    const infoArgs = [...getBaseArgs(), '--dump-single-json', '--no-check-formats', '--skip-download', url];
    const infoStdout = await runYtDlp(infoArgs);
    const info = JSON.parse(infoStdout);

    const safeTitle = sanitizeFilename(info.title || 'video');
    const isAudio = format_id === 'bestaudio';
    const ext = isAudio ? 'mp3' : 'mp4';

    const tempFilePath = path.join(os.tmpdir(), `tubegrab_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`);
    const args = [...getBaseArgs(), url, '-o', tempFilePath];

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

// ── GET /api/debug — Diagnostic endpoint ─────────────────────────────────────

app.get('/api/debug', async (req, res) => {
  const results = { platform: process.platform, nodeVersion: process.version };

  // Check yt-dlp binary
  const bin = getYtDlpPath();
  results.ytdlpPath = bin;
  results.ytdlpExists = fs.existsSync(bin);
  results.cookiesExists = hasCookiesFile();

  // Get yt-dlp version
  try {
    const version = await runYtDlp(['--version']);
    results.ytdlpVersion = version.trim();
  } catch (e) {
    results.ytdlpVersion = `ERROR: ${e.message}`;
  }

  // Test with a known public video
  const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  try {
    const args = [...getBaseArgs(), '--dump-single-json', '--no-check-formats', '--skip-download', testUrl];
    const stdout = await runYtDlp(args);
    const info = JSON.parse(stdout);
    results.testVideo = {
      success: true,
      title: info.title,
      formatCount: info.formats ? info.formats.length : 0,
    };
  } catch (e) {
    results.testVideo = { success: false, error: e.message.substring(0, 500) };
  }

  res.json(results);
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
