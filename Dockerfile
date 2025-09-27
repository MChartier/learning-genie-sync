# Use official Playwright container with browsers and dependencies
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

# Set working directory
WORKDIR /app

# Install supercronic for cron scheduling and jq for downloader script
RUN curl -fsSLo /usr/local/bin/supercronic \
      https://github.com/aptible/supercronic/releases/download/v0.2.30/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic \
    && apt-get update \
    && apt-get install -y --no-install-recommends jq aria2 exiftool\
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests and install deps first for better caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY lg.mjs ./
COPY learning-genie-download.sh ./
COPY docker ./docker

# Ensure scripts are executable
RUN chmod +x docker/*.sh

# Default volume for downloads/auth state
VOLUME ["/data"]

ENV NODE_ENV=production \
    OUTDIR=/data \
    OUTFILE=/tmp/input.json \
    AUTH_PATH=/data/auth.storage.json \
    STATE_PATH=/data/sync-state.json

ENTRYPOINT ["/app/docker/entrypoint.sh"]
