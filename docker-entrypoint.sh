#!/bin/sh
# Refresh yt-dlp on container start when newer than the image-bundled build.
# Fly machines keep running without redeploys; this picks up yt-dlp releases after restarts.
# Set YTDLP_AUTO_UPDATE=0 to skip (use only the Dockerfile-pinned binary).

if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  url="${YTDLP_UPDATE_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux}"
  current="$(/usr/local/bin/yt-dlp --version 2>/dev/null || true)"
  latest="$(
    curl -fsSL "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" 2>/dev/null |
      node -e "
        let d = '';
        process.stdin.on('data', (c) => { d += c; });
        process.stdin.on('end', () => {
          try {
            const t = JSON.parse(d).tag_name;
            if (t) process.stdout.write(String(t));
          } catch {}
        });
      " 2>/dev/null || true
  )"

  if [ -n "$latest" ] && [ "$current" = "$latest" ]; then
    :
  else
    tmp="/tmp/yt-dlp.$$.new"
    if curl -fSL "$url" -o "$tmp" 2>/dev/null && chmod a+rx "$tmp" && mv "$tmp" /usr/local/bin/yt-dlp; then
      :
    else
      rm -f "$tmp"
    fi
  fi
fi

exec "$@"
