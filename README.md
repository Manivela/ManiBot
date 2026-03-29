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

## Scheduled stop/start on Fly (optional, save compute)

GitHub Actions **stop** your production Machines overnight and **start** them again in the morning so you mostly avoid CPU/RAM charges while offline.

Current defaults (Turkey **TRT**, UTC+3, no DST):

- **Stop:** 01:00 Turkey → `0 22 * * *` UTC (`fly-schedule-stop.yml`)
- **Start:** 08:00 Turkey → `0 5 * * *` UTC (`fly-schedule-start.yml`)

Edit those `cron` lines if you change hours (always convert **local → UTC** for the workflow).

**Setup**

1. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**  
   - Name: `FLY_API_TOKEN`  
   - Value: a Fly token with permission to manage the app (same idea as CircleCI deploy).

2. Optionally adjust **start** time in `fly-schedule-start.yml` (default wake **08:00 Turkey**).

3. **Actions** tab → run **Fly — stop manibot** / **Fly — start manibot** manually once to verify.

**Notes**

- Stopped Machines can still incur a **small** rootfs charge; running 24/7 is what costs most.
- A **deploy** from CircleCI may start or replace Machines depending on Fly behavior; after a deploy, check the schedule still matches what you want.
- For **`manibot-dev`**, duplicate these workflows and change `FLY_APP` (or we can add a matrix later).

## yt-dlp cookies (only if needed)

If YouTube blocks playback on hosted IPs, set `YTDLP_COOKIES` as a secret.

- Use exported `youtube.com` cookies in Netscape `cookies.txt` format
- Do not use a raw HTTP `Cookie:` header string
- Prefer a fresh export from an incognito/private YouTube session per yt-dlp wiki guidance
