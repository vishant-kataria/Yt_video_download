FROM node:18-alpine

# Install FFmpeg and Python (required by yt-dlp)
RUN apk add --no-cache ffmpeg python3

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose port
EXPOSE 4000

# Start server
CMD ["npm", "start"]
