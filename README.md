# ManiBot

## Commands

```
npm install
```

for development

```
npm run dev
```

for production

```
npm run start
```

## Music playback

Set `COMMAND_PREFIX` in your environment if you do not want the default `!` prefix.

Available commands:

- `!play <youtube url or search>`
- `!skip`
- `!stop`
- `!pause`
- `!resume`
- `!volume <0-200>`
- `!queue`
- `!nowplaying`
- `!commands`
- `!version`

The bot joins the caller's voice channel, queues tracks per guild, and leaves automatically when the queue ends.

`!version` shows app version and, when available, deploy metadata (`RELEASE_VERSION` and `GIT_SHA`).

## CI deploy metadata

CircleCI deploys `main` to Fly and sets runtime secrets used by `!version`.

Required CircleCI project env var:

- `FLY_API_TOKEN`

## Fly dev deployment

You can run a separate development bot on Fly using `fly.dev.toml`.

Create the dev app once:

```
flyctl apps create manibot-dev
```

Set secrets for the dev app (use a separate Discord bot token):

```
flyctl secrets set BOT_TOKEN=... -a manibot-dev
flyctl secrets set COMMAND_PREFIX=! -a manibot-dev
```

Deploy dev:

```
npm run deploy:fly:dev
```

View dev logs:

```
npm run logs:fly:dev
```

## yt-dlp cookies (only if needed)

If YouTube blocks playback on hosted IPs, set `YTDLP_COOKIES` as a secret.

- Use exported `youtube.com` cookies in Netscape `cookies.txt` format
- Do not use a raw HTTP `Cookie:` header string
- Prefer a fresh export from an incognito/private YouTube session per yt-dlp wiki guidance
