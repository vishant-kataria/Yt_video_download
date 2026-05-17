FROM node:22-alpine

# Install FFmpeg, Python, and curl (required by yt-dlp)
RUN apk add --no-cache ffmpeg python3 curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip postinstall to avoid GitHub API rate limits)
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
