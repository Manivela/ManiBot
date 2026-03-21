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
- `!queue`
- `!nowplaying`
- `!music`

- `!version`

The bot joins the caller's voice channel, queues tracks per guild, and leaves automatically when the queue ends.

`!version` shows app version and, when available, deploy metadata (`RELEASE_VERSION` and `GIT_SHA`).

## CI deploy metadata

CircleCI deploys `main` to Fly and sets runtime secrets used by `!version`.

Required CircleCI project env var:

- `FLY_API_TOKEN`
