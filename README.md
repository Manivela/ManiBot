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

The bot joins the caller's voice channel, queues tracks per guild, and leaves automatically when the queue ends.
