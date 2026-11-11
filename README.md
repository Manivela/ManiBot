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

The bot joins the caller's voice channel as soon as `!play` arrives and stays 30 seconds after
the queue ends. It leaves before the next song if nobody else is in the channel, and `!stop`
makes it leave right away. Downloaded songs are cached on disk (up to 5 GB) and lookups in
memory, so repeats start instantly.

`!version` shows app version and, when available, deploy metadata (`RELEASE_VERSION` and `GIT_SHA`).

### Persisting volume settings

By default the per-guild volume set with `!volume` lives in memory only and resets when the
process restarts. On Fly the Machine is **destroyed** when scaled to zero (overnight) and rebuilt
on deploy, so in-memory state is lost on both — and a Fly volume would add storage cost.

To persist volume for free, point the bot at a [free-tier Upstash Redis](https://upstash.com)
(serverless, accessed over HTTPS — no extra npm dependency). Set both REST credentials:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

On Fly, set them as secrets on **each** app:

```
flyctl secrets set UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... -a manibot
flyctl secrets set UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... -a manibot-dev
```

**Keep dev and prod state separate.** If `manibot` and `manibot-dev` share a Discord server
(same guild IDs) and the same Redis, they will overwrite each other's volume. Either give each
app its **own** Upstash database, or point them at different hash keys with `MANIBOT_VOLUME_KEY`
(e.g. `manibot:volumes` for prod, `manibot-dev:volumes` for dev).

When the variables are unset the bot keeps its previous in-memory behaviour, and any Redis
outage is logged and ignored — it never blocks the `!volume` command or startup.

## Self-hosting (Docker)

Every push to `main` makes CI publish `ghcr.io/manivela/manibot:latest`. `deploy/compose.yaml`
runs it next to an updater that pulls `latest` every 5 minutes and recreates the bot when the
image or `.env` changed. Nothing is exposed to the internet; secrets live only in `.env`.

Once, on GitHub: make the `manibot` package public (Packages → manibot → Package settings →
Change visibility) so the host can pull it without credentials.

On the host (x86-64; at least 4 CPUs or lower `cpus` in `compose.yaml`):

1. Put `deploy/compose.yaml` in an empty folder with a `.env` (not `sample.env`, which sets
   `NODE_ENV=development`):
   ```
   BOT_TOKEN=
   UPSTASH_REDIS_REST_URL=
   UPSTASH_REDIS_REST_TOKEN=
   MANIBOT_VOLUME_KEY=
   SENTRY_DSN=
   COMMAND_PREFIX=!
   ```
2. `docker compose up -d`, then `docker compose logs -f bot` until `Bot is ready`.

On Windows, Docker Desktop must start on sign-in, and the bot runs only while a user is
signed in.

Moving off Fly: run `flyctl scale count 0 -a manibot` before starting the host with the same
`BOT_TOKEN`, then remove the Fly deploy job and both Fly schedule workflows; otherwise two bots
answer every command.

Deploy: push to `main`; it is live within ~5 minutes of CI finishing (`!version` shows the
commit). Logs: Sentry (below), or `docker compose logs --tail 100 bot`.

## Monitoring (Sentry)

With `SENTRY_DSN` set and `NODE_ENV=production`, the bot sends errors, logs (everything it
prints, one `Playing …` line per track, a warning per failed command), a trace per `!play` and
per track start, and its memory/CPU every minute.

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
