FROM node:22-alpine

# Only need FFmpeg for merging video+audio streams
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .

EXPOSE 4000
CMD ["npm", "start"]
