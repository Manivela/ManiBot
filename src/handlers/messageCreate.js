const Sentry = require("@sentry/node");
const debug = require("debug")("messageCreate");
const { PermissionFlagsBits, escapeMarkdown } = require("discord.js");
const { createHash } = require("crypto");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { version } = require("../../package.json");
const { silent } = require("../utils/silent");
const { trackLink } = require("../utils/trackLink");
const store = require("../games/store");
const { canHandOut, setUpPicker } = require("../games/picker");
const { adoptChannels, gameCheck } = require("../games/proposals");

const DEFAULT_PREFIX = process.env.COMMAND_PREFIX || "!";

// Every reply goes out silent: no push notifications from the bot.
const send = (msg, payload) => msg.channel.send(silent(payload));

const BUILD_FINGERPRINT_FILES = [
  "package-lock.json",
  "src/index.js",
  "src/handlers/messageCreate.js",
  "src/handlers/interactionCreate.js",
  "src/handlers/presenceUpdate.js",
  "src/games/picker.js",
  "src/games/proposals.js",
  "src/games/store.js",
  "src/music/player.js",
];

const resolveBuildFingerprint = () => {
  if (process.env.BUILD_FINGERPRINT) {
    return process.env.BUILD_FINGERPRINT;
  }

  const rootDir = join(__dirname, "..", "..");
  const hash = createHash("sha256");
  let usedFiles = 0;

  for (const relativePath of BUILD_FINGERPRINT_FILES) {
    const filePath = join(rootDir, relativePath);
    if (!existsSync(filePath)) {
      continue;
    }

    hash.update(readFileSync(filePath));
    usedFiles += 1;
  }

  if (usedFiles === 0) {
    return "unknown";
  }

  return hash.digest("hex").slice(0, 12);
};

const BUILD_FINGERPRINT = resolveBuildFingerprint();

const buildVersionMessage = () => {
  const releaseId = process.env.FLY_RELEASE_ID || process.env.RELEASE_VERSION;
  const gitSha =
    process.env.GIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.CIRCLE_SHA1;
  const machineId = process.env.FLY_MACHINE_ID || process.env.HOSTNAME;

  const details = [`Version: ${version}`];
  if (releaseId) {
    details.push(`Release: ${releaseId}`);
  }
  if (gitSha) {
    details.push(`Commit: ${gitSha.slice(0, 12)}`);
  }
  if (machineId) {
    details.push(`Instance: ${machineId}`);
  }
  details.push(`Build: ${BUILD_FINGERPRINT}`);

  return details.join("\n");
};

const buildQueueMessage = (queue, linked = true) => {
  const label = (track) => (linked ? trackLink(track) : track.title);
  const entries = [];

  if (queue.currentTrack) {
    entries.push(
      `▶️ Now playing: **${label(queue.currentTrack)}** (${queue.currentTrack.durationLabel})`,
    );
  }

  if (queue.tracks.length > 0) {
    entries.push(
      ...queue.tracks
        .slice(0, 10)
        .map(
          (track, index) =>
            `${index + 1}. **${label(track)}** (${track.durationLabel})`,
        ),
    );
  }

  if (entries.length === 0) {
    return "Queue is empty.";
  }

  if (queue.tracks.length > 10) {
    entries.push(`…and ${queue.tracks.length - 10} more track(s).`);
  }

  const message = entries.join("\n");
  // Eleven long titles with links can pass Discord's 2000-character cap.
  return linked && message.length > 2000
    ? buildQueueMessage(queue, false)
    : message;
};

const ensureMemberInVoiceChannel = async (msg) => {
  if (msg.member?.voice?.channel) {
    return msg.member.voice.channel;
  }

  await send(msg, "Join a voice channel first.");
  return null;
};

const ensureSameVoiceChannel = async (msg, queue) => {
  const memberVoiceChannel = await ensureMemberInVoiceChannel(msg);
  if (!memberVoiceChannel) {
    return null;
  }

  if (queue && queue.voiceChannelId !== memberVoiceChannel.id) {
    await send(
      msg,
      "Music playback is already active in another voice channel.",
    );
    return null;
  }

  return memberVoiceChannel;
};

const ensureCanControlQueue = async (msg, queue) => {
  if (!queue) {
    return true;
  }

  return Boolean(await ensureSameVoiceChannel(msg, queue));
};

const ensureCanManageRoles = async (msg) => {
  if (msg.member?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return true;
  }

  await send(msg, "You need the Manage Roles permission for that.");
  return false;
};

// Commands that start or steer playback; with a music channel set they only
// work there.
const MUSIC_CONTROL_COMMANDS = new Set([
  "play",
  "skip",
  "stop",
  "pause",
  "resume",
  "volume",
  "autoplay",
]);
const REDIRECT_REPLY_MS = 10_000;

// Elsewhere the command is deleted and answered with a short-lived pointer to
// the music channel, and the member gets the role that opens it. Returns
// whether it redirected.
const redirectToMusicChannel = async (msg) => {
  // Music mustn't depend on Redis: if the setting can't be read, play anyway.
  const state = await store.getGuildState(msg.guild.id).catch(() => null);
  const channelId = state?.config.musicChannelId;
  const channel = channelId && msg.guild.channels.cache.get(channelId);
  if (!channel || channel.id === msg.channel.id) {
    return false;
  }

  const role = channel.permissionOverwrites.cache
    .filter((o) => o.allow.has(PermissionFlagsBits.ViewChannel))
    .map((o) => msg.guild.roles.cache.get(o.id))
    .find(canHandOut);
  let gaveRole = false;
  if (role && !msg.member.roles.cache.has(role.id)) {
    try {
      await msg.member.roles.add(role, "Tried a music command");
      store.setOptOut(msg.guild.id, state, msg.author.id, role.id, false);
      gaveRole = true;
    } catch (error) {
      debug(error);
    }
  }

  msg.delete().catch(debug); // needs Manage Messages
  const reply = await send(msg, {
    content: `${msg.author}, music commands go in ${channel}.${gaveRole ? ` I gave you **${escapeMarkdown(role.name)}** so you can see it.` : ""}`,
    allowedMentions: { users: [msg.author.id] },
  });
  setTimeout(() => reply.delete().catch(debug), REDIRECT_REPLY_MS);
  return true;
};

const getUserFacingErrorMessage = (error) => {
  const errorMessage = error?.message || "";
  if (
    error?.name === "AbortError" ||
    /operation was aborted/i.test(errorMessage)
  ) {
    return "Playback request was interrupted. Please try !play again.";
  }

  if (
    /Cannot find module '@discordjs\/opus'|Cannot find module 'node-opus'|Cannot find module 'opusscript'/i.test(
      errorMessage,
    )
  ) {
    return "Missing Opus dependency. Install `opusscript` and restart the bot.";
  }

  return (
    errorMessage.split("\n")[0] || "Music playback failed. Please try again."
  );
};

const createMessageCreateHandler = ({
  musicPlayer,
  prefix = DEFAULT_PREFIX,
} = {}) => {
  return async (msg) => {
    if (msg.author?.bot || !msg.guild) {
      return;
    }

    const content = msg.content.trim();
    if (content === "ping") {
      await send(msg, "pong");
      return;
    }

    if (!content.startsWith(prefix)) {
      return;
    }

    const [commandName, ...args] = content
      .slice(prefix.length)
      .trim()
      .split(/\s+/);
    if (!commandName) {
      return;
    }

    const command = commandName.toLowerCase();

    try {
      if (
        MUSIC_CONTROL_COMMANDS.has(command) &&
        (await redirectToMusicChannel(msg))
      ) {
        return;
      }

      switch (command) {
        case "play": {
          const query = args.join(" ").trim();
          if (!query) {
            await send(msg, `Usage: ${prefix}play <youtube url or search>`);
            return;
          }

          const queue = musicPlayer.getQueue(msg.guild.id);
          const memberVoiceChannel = await ensureSameVoiceChannel(msg, queue);
          if (!memberVoiceChannel) {
            return;
          }

          await Sentry.startSpan({ name: "!play", op: "command" }, async () => {
            // Typing while the lookup runs. Not awaited, so a missing permission
            // can't block playback.
            msg.channel.sendTyping().catch(debug);

            const result = await musicPlayer.enqueue({
              guild: msg.guild,
              voiceChannel: memberVoiceChannel,
              textChannel: msg.channel,
              query,
              requestedBy: msg.author.username,
            });

            if (result.tracksAdded === 1) {
              if (result.started) {
                await send(
                  msg,
                  `Queued **${trackLink(result.tracks[0])}** (${result.tracks[0].durationLabel}).`,
                );
              }
              return;
            }

            await send(msg, `Queued ${result.tracksAdded} track(s).`);
          });
          return;
        }

        case "skip": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const skippedTrack = musicPlayer.skip(
            msg.guild.id,
            msg.author.username,
          );
          await send(msg, `Skipped **${trackLink(skippedTrack)}**.`);
          return;
        }

        case "stop": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          musicPlayer.stop(msg.guild.id, msg.author.username);
          await send(msg, "Stopped playback and cleared the queue.");
          return;
        }

        case "pause": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const pausedTrack = musicPlayer.pause(msg.guild.id);
          await send(msg, `Paused **${trackLink(pausedTrack)}**.`);
          return;
        }

        case "resume": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const resumedTrack = musicPlayer.resume(msg.guild.id);
          await send(msg, `Resumed **${trackLink(resumedTrack)}**.`);
          return;
        }

        case "volume": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          if (!args.length) {
            const currentVolume = musicPlayer.getVolume(msg.guild.id);
            await send(msg, `Current volume: **${currentVolume}%**.`);
            return;
          }

          const value = Number(args[0]);
          if (!Number.isFinite(value)) {
            await send(msg, `Usage: ${prefix}volume <0-200>`);
            return;
          }

          const volumePercent = musicPlayer.setVolume(
            msg.guild.id,
            value / 100,
          );
          await send(msg, `Volume set to **${volumePercent}%**.`);
          return;
        }

        case "autoplay": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const enabled = musicPlayer.toggleAutoplay(msg.guild.id);
          await send(
            msg,
            enabled
              ? "🔁 Autoplay on: when the queue runs out I'll keep playing related songs."
              : "Autoplay off.",
          );
          return;
        }

        case "queue": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          await send(
            msg,
            buildQueueMessage(queue || { currentTrack: null, tracks: [] }),
          );
          return;
        }

        case "nowplaying":
        case "np": {
          const currentTrack = musicPlayer.getNowPlaying(msg.guild.id);
          if (!currentTrack) {
            await send(msg, "Nothing is playing right now.");
            return;
          }

          await send(
            msg,
            `▶️ Now playing: **${trackLink(currentTrack)}** (${currentTrack.durationLabel})`,
          );
          return;
        }

        case "musicchannel": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          // Named from elsewhere (the admin channel) so nothing shows in it.
          const off = args[0]?.toLowerCase() === "off";
          const mentioned = msg.mentions?.channels.first();
          const target =
            mentioned?.guild?.id === msg.guild.id ? mentioned : msg.channel;
          const state = await store.getGuildState(msg.guild.id);
          store.setConfig(msg.guild.id, state, {
            musicChannelId: off ? undefined : target.id,
          });
          await send(msg, {
            content: off
              ? "Music commands work in any channel again."
              : `Music commands now only work in ${target}. Elsewhere I'll delete them, point people there, and give them the role that opens it.`,
          });
          return;
        }

        case "botchannel": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          const state = await store.getGuildState(msg.guild.id);
          store.setConfig(msg.guild.id, state, {
            botChannelId: msg.channel.id,
          });
          await send(msg, {
            content: [
              "Game proposals will come here. Keep this channel visible only to whoever approves them.",
              `Next, from here: \`${prefix}rolepicker\` (I'll set up a #roles channel), \`${prefix}musicchannel #channel\` for your music channel, \`${prefix}pickable <role>\` for extra roles like DJ, and \`${prefix}gamecheck\` any time to find games missing a role or channel.`,
            ].join("\n"),
          });
          return;
        }

        case "rolepicker": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          const state = await store.getGuildState(msg.guild.id);
          const channel = await setUpPicker(msg.guild, state);
          if (channel.id === msg.channel.id) {
            await msg.delete().catch(debug); // needs Manage Messages
          } else {
            await send(msg, {
              content: `The role picker is ready in ${channel}.`,
            });
          }
          return;
        }

        case "adopt": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          const state = await store.getGuildState(msg.guild.id);
          const { adopted, skipped, sawEverything } = await adoptChannels(
            msg.guild,
            state,
          );
          const list = (items) =>
            items
              .map(({ channel, role }) => `${channel} (${role.name})`)
              .join(", ");
          const fresh = adopted.filter((item) => item.isNew);
          const already = adopted.length - fresh.length;
          const lines = [
            fresh.length
              ? `Adopted ${fresh.length} game channel${fresh.length === 1 ? "" : "s"}: ${list(fresh)}. I'll keep seeing them, and their roles are in the picker.`
              : "No new game channels to adopt.",
          ];
          if (already) {
            lines.push(`${already} already adopted earlier, left as they are.`);
          }
          if (skipped.length) {
            lines.push(
              `Skipped, named differently from the role that opens them: ${list(skipped)}. If one is a game channel, link it from \`${prefix}gamecheck\` when its game comes up.`,
            );
          }
          lines.push(
            sawEverything
              ? "You can take Administrator away from me now."
              : "I only checked channels I can see. Give me Administrator, run this again, then take it away.",
          );
          // shortcut: one message, cut at Discord's 2000 characters; split it if a server has that many channels.
          await send(msg, {
            content: lines.join("\n").slice(0, 2000),
            allowedMentions: { parse: [] },
          });
          return;
        }

        case "gamecheck": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          const state = await store.getGuildState(msg.guild.id);
          for (const message of gameCheck(msg.guild, state)) {
            await send(msg, message);
          }
          return;
        }

        case "pickable": {
          if (!(await ensureCanManageRoles(msg))) {
            return;
          }

          const name = args.join(" ").trim().toLowerCase();
          const role = msg.guild.roles.cache.find(
            (r) => r.name.toLowerCase() === name,
          );
          const isOwner = msg.author.id === msg.guild.ownerId;
          if (
            !canHandOut(role) ||
            (!isOwner && msg.member.roles.highest.comparePositionTo(role) <= 0)
          ) {
            await send(
              msg,
              `Usage: ${prefix}pickable <role name>, for a role with no permissions, below my role and yours.`,
            );
            return;
          }

          const state = await store.getGuildState(msg.guild.id);
          const extras = new Set(state.config.extraRoleIds || []);
          const added = !extras.has(role.id);
          if (added) {
            extras.add(role.id);
          } else {
            extras.delete(role.id);
          }
          store.setConfig(msg.guild.id, state, { extraRoleIds: [...extras] });
          await send(msg, {
            content: `**${escapeMarkdown(role.name)}** is ${added ? "now in" : "out of"} the role picker.`,
          });
          return;
        }

        case "commands":
        case "help": {
          await send(
            msg,
            [
              "Commands:",
              "",
              "General:",
              "ping",
              `${prefix}commands (${prefix}help)`,
              `${prefix}version`,
              "",
              "Music:",
              `${prefix}play <youtube url or search>`,
              `${prefix}skip`,
              `${prefix}stop`,
              `${prefix}pause`,
              `${prefix}resume`,
              `${prefix}volume <0-200>`,
              `${prefix}autoplay`,
              `${prefix}queue`,
              `${prefix}nowplaying`,
              `${prefix}np`,
              "",
              "Server setup (needs Manage Roles):",
              `${prefix}botchannel: game proposals come to this channel (start here)`,
              `${prefix}rolepicker: sets up a #roles channel with the role picker (hidden until it's ready)`,
              `${prefix}pickable <role name>: adds or removes an extra role, like DJ, in the picker`,
              `${prefix}gamecheck: lists games missing a role or channel`,
              `${prefix}adopt: once, with Administrator: lets me see your existing game channels`,
              `${prefix}musicchannel [#channel|off]: music commands only work in that channel (default: this one)`,
            ].join("\n"),
          );
          return;
        }

        case "version": {
          await send(msg, buildVersionMessage());
          return;
        }

        default:
          return;
      }
    } catch (error) {
      debug(error);
      Sentry.logger.warn(`${prefix}${command} failed: ${error?.message}`, {
        command,
        guild_id: msg.guild.id,
      });
      await send(msg, getUserFacingErrorMessage(error));
    }
  };
};

module.exports = {
  buildVersionMessage,
  buildQueueMessage,
  createMessageCreateHandler,
};
