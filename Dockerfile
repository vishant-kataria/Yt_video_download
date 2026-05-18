FROM node:22-alpine

# Install FFmpeg, Python (for yt-dlp), and curl
RUN apk add --no-cache ffmpeg python3 curl

# Download wgcf (generates Cloudflare WARP WireGuard config)
RUN curl -L https://github.com/ViRb3/wgcf/releases/download/v2.2.9/wgcf_2.2.9_linux_amd64 -o /usr/local/bin/wgcf \
    && chmod +x /usr/local/bin/wgcf

# Download wireproxy (userspace WireGuard → SOCKS5 proxy, no root needed)
RUN curl -L https://github.com/pufferffish/wireproxy/releases/download/v1.1.2/wireproxy_linux_amd64.tar.gz -o /tmp/wireproxy.tar.gz \
    && tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/wireproxy \
    && rm /tmp/wireproxy.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts

# Download yt-dlp nightly binary
RUN mkdir -p ./node_modules/youtube-dl-exec/bin \
    && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o ./node_modules/youtube-dl-exec/bin/yt-dlp \
    && chmod +x ./node_modules/youtube-dl-exec/bin/yt-dlp

COPY . .

# Fix Windows CRLF line endings and make start.sh executable
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

EXPOSE 4000
CMD ["/app/start.sh"]
