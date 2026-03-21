const debug = require("debug")("messageCreate");
const { version } = require("../../package.json");

const DEFAULT_PREFIX = process.env.COMMAND_PREFIX || "!";

const buildVersionMessage = () => {
  const releaseId = process.env.FLY_RELEASE_ID || process.env.RELEASE_VERSION;
  const gitSha = process.env.GIT_SHA;

  const details = [`Version: ${version}`];
  if (releaseId) {
    details.push(`Release: ${releaseId}`);
  }
  if (gitSha) {
    details.push(`Commit: ${gitSha}`);
  }

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
            await msg.channel.send(
              `Queued **${result.tracks[0].title}** (${result.tracks[0].durationLabel}).`,
            );
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

        case "music":
        case "help": {
          await msg.channel.send(
            [
              `Music commands with prefix \`${prefix}\`:`,
              `${prefix}play <youtube url or search>`,
              `${prefix}skip`,
              `${prefix}stop`,
              `${prefix}pause`,
              `${prefix}resume`,
              `${prefix}queue`,
              `${prefix}nowplaying`,
              `${prefix}version`,
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
      await msg.channel.send(
        error?.message || "Music playback failed. Please try again.",
      );
    }
  };
};

module.exports = {
  buildVersionMessage,
  buildQueueMessage,
  createMessageCreateHandler,
};
