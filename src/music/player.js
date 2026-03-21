const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");
const Sentry = require("@sentry/node");
const debug = require("debug")("musicPlayer");
const play = require("play-dl");

const guildQueues = new Map();

const formatDuration = (durationRaw) => {
  if (!durationRaw) {
    return "live";
  }

  if (Array.isArray(durationRaw)) {
    return durationRaw.join(":");
  }

  return durationRaw;
};

const normalizeTrack = (track, requestedBy) => ({
  title: track.title || "Unknown title",
  url: track.url,
  durationLabel: formatDuration(track.durationRaw),
  requestedBy,
});

const handleQueueError = (queue, error, message) => {
  debug(error);
  Sentry.captureException(error, (scope) => {
    scope.addBreadcrumb({
      level: "error",
      type: "debug",
      category: "console",
      message,
    });
    return scope;
  });

  if (queue?.textChannel) {
    queue.textChannel
      .send("Playback failed. Skipping to the next track.")
      .catch(debug);
  }
};

const cleanupQueue = (guildId) => {
  const queue = guildQueues.get(guildId);
  if (!queue) {
    return;
  }

  queue.tracks = [];
  queue.currentTrack = null;

  if (queue.connection) {
    queue.connection.destroy();
  }

  guildQueues.delete(guildId);
};

const processQueue = async (queue) => {
  if (!queue || queue.isProcessing) {
    return;
  }

  if (
    queue.currentTrack ||
    queue.player.state.status !== AudioPlayerStatus.Idle
  ) {
    return;
  }

  queue.isProcessing = true;
  let shouldRetry = false;
  let nextTrack = null;

  try {
    nextTrack = queue.tracks.shift();
    if (!nextTrack) {
      cleanupQueue(queue.guildId);
      return;
    }

    queue.currentTrack = nextTrack;
    const stream = await play.stream(nextTrack.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      metadata: nextTrack,
    });

    queue.player.play(resource);

    if (queue.textChannel) {
      await queue.textChannel.send(
        `▶️ Now playing: **${nextTrack.title}** (${nextTrack.durationLabel})`,
      );
    }
  } catch (error) {
    queue.currentTrack = null;
    shouldRetry = queue.tracks.length > 0;
    handleQueueError(
      queue,
      error,
      `failed to start track ${nextTrack?.title || "unknown"}`,
    );
  } finally {
    queue.isProcessing = false;
  }

  if (shouldRetry) {
    await processQueue(queue);
  }
};

const createQueue = ({ guildId, textChannel, voiceChannelId }) => {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const queue = {
    guildId,
    player,
    connection: null,
    currentTrack: null,
    isProcessing: false,
    textChannel,
    tracks: [],
    voiceChannelId,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    if (!queue.currentTrack) {
      return;
    }

    queue.currentTrack = null;
    processQueue(queue).catch((error) => {
      handleQueueError(queue, error, "failed to advance the queue");
      cleanupQueue(queue.guildId);
    });
  });

  player.on("error", (error) => {
    queue.currentTrack = null;
    handleQueueError(queue, error, "audio player emitted an error");
    processQueue(queue).catch((processError) => {
      handleQueueError(queue, processError, "failed after audio player error");
      cleanupQueue(queue.guildId);
    });
  });

  guildQueues.set(guildId, queue);
  return queue;
};

const ensureConnection = async (queue, voiceChannel) => {
  if (queue.connection) {
    if (queue.voiceChannelId !== voiceChannel.id) {
      throw new Error(
        "Music playback is already active in another voice channel.",
      );
    }

    return queue.connection;
  }

  queue.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch (error) {
      handleQueueError(queue, error, "voice connection disconnected");
      cleanupQueue(queue.guildId);
    }
  });

  await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
  queue.connection.subscribe(queue.player);
  queue.voiceChannelId = voiceChannel.id;

  return queue.connection;
};

const resolveTracks = async (query, requestedBy) => {
  const type = play.yt_validate(query);

  if (type === "video") {
    const video = await play.video_basic_info(query);
    return [normalizeTrack(video.video_details, requestedBy)];
  }

  if (type === "playlist") {
    const playlist = await play.playlist_info(query, { incomplete: true });
    const videos = await playlist.all_videos();
    return videos
      .filter(Boolean)
      .map((track) => normalizeTrack(track, requestedBy));
  }

  const results = await play.search(query, {
    limit: 1,
    source: { youtube: "video" },
  });

  if (!results.length) {
    throw new Error("No YouTube results found for that query.");
  }

  return [normalizeTrack(results[0], requestedBy)];
};

const getQueue = (guildId) => guildQueues.get(guildId) || null;

const enqueue = async ({
  guild,
  voiceChannel,
  textChannel,
  query,
  requestedBy,
}) => {
  const tracks = await resolveTracks(query, requestedBy);
  if (!tracks.length) {
    throw new Error("No playable tracks were found.");
  }

  const queue =
    getQueue(guild.id) ||
    createQueue({
      guildId: guild.id,
      textChannel,
      voiceChannelId: voiceChannel.id,
    });

  queue.textChannel = textChannel;
  queue.voiceChannelId = voiceChannel.id;

  await ensureConnection(queue, voiceChannel);

  queue.tracks.push(...tracks);
  await processQueue(queue);

  return {
    started: Boolean(queue.currentTrack),
    tracks,
    tracksAdded: tracks.length,
  };
};

const ensureQueueHasTrack = (guildId) => {
  const queue = getQueue(guildId);
  if (!queue || !queue.currentTrack) {
    throw new Error("Nothing is playing right now.");
  }

  return queue;
};

const skip = (guildId) => {
  const queue = ensureQueueHasTrack(guildId);
  const skippedTrack = queue.currentTrack;
  queue.player.stop(true);
  return skippedTrack;
};

const stop = (guildId) => {
  const queue = getQueue(guildId);
  if (!queue) {
    throw new Error("Nothing is playing right now.");
  }

  queue.tracks = [];
  queue.currentTrack = null;
  queue.player.stop(true);
  cleanupQueue(guildId);
};

const pause = (guildId) => {
  const queue = ensureQueueHasTrack(guildId);
  queue.player.pause(true);
  return queue.currentTrack;
};

const resume = (guildId) => {
  const queue = ensureQueueHasTrack(guildId);
  queue.player.unpause();
  return queue.currentTrack;
};

const getNowPlaying = (guildId) => getQueue(guildId)?.currentTrack || null;

module.exports = {
  cleanupQueue,
  enqueue,
  getNowPlaying,
  getQueue,
  pause,
  resume,
  skip,
  stop,
};
