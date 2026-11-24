# ManiBot

## Development

`npm install`, then `npm run dev` with a `.env` copied from `sample.env`.

## Music playback

Set `COMMAND_PREFIX` in your environment if you do not want the default `!` prefix.

Available commands:

- `!play <youtube url or search>`
- `!skip`
- `!stop`
- `!pause`
- `!resume`
- `!volume <0-200>`
- `!autoplay`
- `!queue`
- `!nowplaying`
- `!commands`
- `!version`

Server setup commands are under [Game roles](#game-roles).

The bot joins the caller's voice channel as soon as `!play` arrives and stays 30 seconds after
the queue ends. It leaves before the next song if nobody else is in the channel, and `!stop`
makes it leave right away. Downloaded songs are cached on disk (up to 1 GB) and lookups in
memory, so repeats start instantly.

Each song gets a "Now playing" message with pause/resume, skip, stop and autoplay buttons for
whoever is in the bot's voice channel. When the song ends the buttons go away, and a skip or
stop rewrites the line to say who did it, so the channel reads as a history. Buttons a restart
left behind are cleared the next time the bot plays in that channel (needs Read Message History).

`!autoplay` toggles autoplay, which is off by default and resets when the bot leaves. When the
queue runs out, the bot keeps playing songs from YouTube's Mix of the last song, skipping
livestreams and the last 20 songs it played.

`!version` shows app version and, when available, deploy metadata (`RELEASE_VERSION` and `GIT_SHA`).

### Persisting volume settings

By default the per-guild volume set with `!volume` lives in memory only and resets when the
process restarts, which every deploy does.

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

## Game roles

When a member starts a game, the bot gives them two roles: the game's role (e.g. `VALORANT`),
which opens its text channel and stays, and its in-game role (`VALORANT-ingame`), shown
separately in the member list, which goes away when they stop. Games are tracked by Discord's
application ID, so roles and channels can be renamed freely. The first time a game is seen,
roles named exactly after it are linked automatically.

Games with no roles yet are proposed: once 2 members have played one within 30 days (1 with
`NODE_ENV=development`), the bot asks in the bot channel and waits. Create makes both roles
(the in-game one coloured and shown separately) and a channel only the game role can see;
"Roles only" skips the channel; "Link to existing…" attaches roles and a channel you already
have; Ignore stops it asking. Only members with Manage Roles can answer.

Run the setup commands from the bot channel: their replies are silent (no push notifications), and
nothing shows up in the channels members use. Members pick or drop game roles themselves with the
button `!rolepicker` posts. The picker offers every role the bot knows as a game: linked games, roles with an
exact `-ingame` twin, and roles that open a game channel the bot can see. Dropping one
sticks: the bot won't hand it back when they next play.

Setup commands (Manage Roles):

- `!botchannel`: proposals go to this channel; keep it private to whoever approves. The bot also
  says here when it comes up on a new commit, with a link to what changed.
- `!rolepicker`: sets up a `#roles` channel with the picker button, hidden from everyone until
  it's ready and closed to posting. Run again, it hides that channel (wherever it's been moved or
  renamed) while it swaps the button.
- `!pickable <role name>`: adds or removes a non-game role (like DJ) in the picker. Only roles
  with no permissions, below the bot's role and yours.
- `!propose`: lists the games members are playing right now that aren't set up (ignored ones
  too). Pick one and the list becomes its proposal, in the channel you ran it in.
- `!gamecheck`: lists games missing a role or channel (say a role named a bit differently from
  the game), each with a button to link what's missing.
- `!adopt`: run once while the bot has Administrator. Discord hides channels from the bot unless
  it can see them, so hand-made game channels are invisible to it. It adds itself to every text
  channel that is hidden from everyone and opened by a no-permission role named like it
  (`#among-us` ↔ `Among Us`), then reports what it adopted and what it skipped. Those roles join
  the picker, and games link to their channel when played. Take Administrator away afterwards.
- `!musicchannel [#channel]`: music commands (`!play`, `!skip`, `!stop`, `!pause`, `!resume`, `!volume`,
  `!autoplay`) only work in that channel (default: this one). Elsewhere the bot deletes them (with Manage Messages),
  gives the member the role that opens the music channel (a role with no permissions), and
  replies for 10 seconds. `!musicchannel off` lifts it.

The bot needs Manage Roles and Manage Channels, and its role above every game role. State lives
in the same Upstash Redis as the volume (one hash per server, `manibot:guild:<id>`); without
Upstash it is kept in memory and lost on restart. If Redis is configured but unreachable, the
bot hands out and proposes nothing until it can read it again. Stored per server: the game
list, who played a game not set up yet (deleted once it's proposed, and after 30 days), and
who dropped which game role.

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
   APP_ENV=
   COMMAND_PREFIX=!
   ```
2. `docker compose up -d`, then `docker compose logs -f bot` until `Bot is ready`.

On Windows, Docker Desktop must start on sign-in, and the bot runs only while a user is
signed in. `deploy/run.bat`, placed next to `compose.yaml`, does step 2 on a double-click.

Deploy: push to `main`; it is live within ~5 minutes of CI finishing (`!version` shows the
commit). Logs: Sentry (below), or `docker compose logs --tail 100 bot`.

## Monitoring (Sentry)

With `SENTRY_DSN` set and `NODE_ENV=production`, the bot sends errors, logs (everything it
prints, one `Playing …` line per track, a warning per failed command), a trace per `!play` and
per track start, and its memory/CPU every minute. Off Fly it also counts a `heartbeat` metric
every 5 minutes while connected to Discord; a Sentry metric monitor emails when none arrives
for 15 minutes.

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
