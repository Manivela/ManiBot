const debug = require("debug")("messageCreate");
const { createHash } = require("crypto");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { version } = require("../../package.json");

const DEFAULT_PREFIX = process.env.COMMAND_PREFIX || "!";

const BUILD_FINGERPRINT_FILES = [
  "package-lock.json",
  "src/index.js",
  "src/handlers/messageCreate.js",
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

const buildQueueMessage = (queue) => {
  const entries = [];

  if (queue.currentTrack) {
    entries.push(
      `▶️ Now playing: **${queue.currentTrack.title}** (${queue.currentTrack.durationLabel})`,
    );
  }

  if (queue.tracks.length > 0) {
    entries.push(
      ...queue.tracks
        .slice(0, 10)
        .map(
          (track, index) =>
            `${index + 1}. **${track.title}** (${track.durationLabel})`,
        ),
    );
  }

  if (entries.length === 0) {
    return "Queue is empty.";
  }

  if (queue.tracks.length > 10) {
    entries.push(`…and ${queue.tracks.length - 10} more track(s).`);
  }

  return entries.join("\n");
};

const ensureMemberInVoiceChannel = async (msg) => {
  if (msg.member?.voice?.channel) {
    return msg.member.voice.channel;
  }

  await msg.channel.send("Join a voice channel first.");
  return null;
};

const ensureSameVoiceChannel = async (msg, queue) => {
  const memberVoiceChannel = await ensureMemberInVoiceChannel(msg);
  if (!memberVoiceChannel) {
    return null;
  }

  if (queue && queue.voiceChannelId !== memberVoiceChannel.id) {
    await msg.channel.send(
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
      await msg.channel.send("pong");
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
      switch (command) {
        case "play": {
          const query = args.join(" ").trim();
          if (!query) {
            await msg.channel.send(
              `Usage: ${prefix}play <youtube url or search>`,
            );
            return;
          }

          const queue = musicPlayer.getQueue(msg.guild.id);
          const memberVoiceChannel = await ensureSameVoiceChannel(msg, queue);
          if (!memberVoiceChannel) {
            return;
          }

          const result = await musicPlayer.enqueue({
            guild: msg.guild,
            voiceChannel: memberVoiceChannel,
            textChannel: msg.channel,
            query,
            requestedBy: msg.author.username,
          });

          if (result.tracksAdded === 1) {
            if (result.started) {
              await msg.channel.send(
                `Queued **${result.tracks[0].title}** (${result.tracks[0].durationLabel}).`,
              );
            }
            return;
          }

          await msg.channel.send(`Queued ${result.tracksAdded} track(s).`);
          return;
        }

        case "skip": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const skippedTrack = musicPlayer.skip(msg.guild.id);
          await msg.channel.send(`Skipped **${skippedTrack.title}**.`);
          return;
        }

        case "stop": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          musicPlayer.stop(msg.guild.id);
          await msg.channel.send("Stopped playback and cleared the queue.");
          return;
        }

        case "pause": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const pausedTrack = musicPlayer.pause(msg.guild.id);
          await msg.channel.send(`Paused **${pausedTrack.title}**.`);
          return;
        }

        case "resume": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          const canControlQueue = await ensureCanControlQueue(msg, queue);
          if (!canControlQueue) {
            return;
          }

          const resumedTrack = musicPlayer.resume(msg.guild.id);
          await msg.channel.send(`Resumed **${resumedTrack.title}**.`);
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
            await msg.channel.send(`Current volume: **${currentVolume}%**.`);
            return;
          }

          const value = Number(args[0]);
          if (!Number.isFinite(value)) {
            await msg.channel.send(`Usage: ${prefix}volume <0-200>`);
            return;
          }

          const volumePercent = musicPlayer.setVolume(
            msg.guild.id,
            value / 100,
          );
          await msg.channel.send(`Volume set to **${volumePercent}%**.`);
          return;
        }

        case "queue": {
          const queue = musicPlayer.getQueue(msg.guild.id);
          await msg.channel.send(
            buildQueueMessage(queue || { currentTrack: null, tracks: [] }),
          );
          return;
        }

        case "nowplaying":
        case "np": {
          const currentTrack = musicPlayer.getNowPlaying(msg.guild.id);
          if (!currentTrack) {
            await msg.channel.send("Nothing is playing right now.");
            return;
          }

          await msg.channel.send(
            `▶️ Now playing: **${currentTrack.title}** (${currentTrack.durationLabel})`,
          );
          return;
        }

        case "commands":
        case "help": {
          await msg.channel.send(
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
              `${prefix}queue`,
              `${prefix}nowplaying`,
              `${prefix}np`,
            ].join("\n"),
          );
          return;
        }

        case "version": {
          await msg.channel.send(buildVersionMessage());
          return;
        }

        default:
          return;
      }
    } catch (error) {
      debug(error);
      await msg.channel.send(getUserFacingErrorMessage(error));
    }
  };
};

module.exports = {
  buildVersionMessage,
  buildQueueMessage,
  createMessageCreateHandler,
};
