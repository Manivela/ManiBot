# syntax = docker/dockerfile:1

# Must be >= 22.0.0: yt-dlp's EJS YouTube signature/n-challenge solver requires
# a Node >= 22 runtime (or Deno). On Node 20 the solver fails and YouTube returns
# only storyboard images, surfacing as "Requested format is not available".
ARG NODE_VERSION=22.23.0
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base as build

RUN apt-get update -qq && \
    apt-get install -y build-essential pkg-config python-is-python3

COPY --link package-lock.json package.json ./
RUN npm ci

COPY --link . .


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

# Deno is yt-dlp's recommended (sandboxed) runtime for solving YouTube's
# signature/n-challenges. Preferring it keeps challenge-solving working
# independently of the app's Node version. Node 22 (the base image) stays as a
# fallback runtime via YTDLP_JS_RUNTIME below.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN chmod a+rx /usr/local/bin/deno && deno --version
ENV YTDLP_JS_RUNTIME=deno,node

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --from=build /app /app

# Shown by !version. CI passes these for the published image; on Fly the
# GIT_SHA/RELEASE_VERSION secrets override them at runtime.
ARG GIT_SHA=""
ARG RELEASE_VERSION=""
ENV GIT_SHA=${GIT_SHA} RELEASE_VERSION=${RELEASE_VERSION}

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# node directly, not npm: a deploy's SIGTERM must reach it (src/index.js saves what's playing).
CMD [ "node", "src/index.js" ]
