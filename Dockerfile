FROM node:22-slim

# Install FFmpeg, Python, curl, and unzip
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Deno (the official JS runtime for yt-dlp)
RUN curl -fsSL https://dl.deno.land/release/latest/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip postinstall to avoid GitHub rate limits)
RUN npm install --ignore-scripts

# Download the latest yt-dlp nightly binary for Linux
RUN mkdir -p ./node_modules/youtube-dl-exec/bin \
    && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o ./node_modules/youtube-dl-exec/bin/yt-dlp \
    && chmod +x ./node_modules/youtube-dl-exec/bin/yt-dlp

# Copy application code
COPY . .

# Expose port
EXPOSE 4000

# Start server
CMD ["npm", "start"]
