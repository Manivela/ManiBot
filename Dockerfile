# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=20.19.0
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base as build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install -y build-essential pkg-config python-is-python3

# Install node modules
COPY --link package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY --link . .


# Final stage for app image
FROM base

# Bootstrap yt-dlp (fallback if startup upgrade fails). docker-entrypoint.sh upgrades
# to GitHub latest on each machine start when the version differs.
ARG YTDLP_VERSION=2026.03.17

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends curl ca-certificates ffmpeg && \
    curl -fSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version && \
    rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy built application
COPY --from=build /app /app

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD [ "npm", "run", "start" ]
