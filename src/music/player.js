const { spawn } = require("child_process");
const { writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { PassThrough } = require("stream");
const STREAM_START_TIMEOUT_MS = 45_000;
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");
const Sentry = require("@sentry/node");
const debug = require("debug")("musicPlayer");
const play = require("play-dl");

const resolveCookiesFilePath = () => {
  if (process.env.YTDLP_COOKIES_FILE) {
    return process.env.YTDLP_COOKIES_FILE;
  }

  if (!process.env.YTDLP_COOKIES) {
    return null;
  }

  const filePath = join(tmpdir(), "manibot-ytdlp-cookies.txt");
  try {
    writeFileSync(filePath, process.env.YTDLP_COOKIES, {
      encoding: "utf8",
      mode: 0o600,
    });
    debug("yt-dlp using cookies content from YTDLP_COOKIES");
    return filePath;
  } catch (error) {
    debug("failed to write cookies file from YTDLP_COOKIES", error);
    return null;
  }
};

const YTDLP_COOKIES_PATH = resolveCookiesFilePath();
const IS_FLY_RUNTIME = Boolean(
  process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID,
);

const getFormatSelectors = () => {
  if (process.env.YTDLP_FORMAT) {
    return [process.env.YTDLP_FORMAT];
  }

  return [
    "251/250/249/140/139/18/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio*/bestaudio/best",
    "bestaudio/best",
  ];
};

const buildYtDlpArgs = (url, formatSelector, useCookies = false) => {
  const args = [
    "--js-runtimes",
    process.env.YTDLP_JS_RUNTIME || "node",
    "-f",
    formatSelector,
    "--no-playlist",
    "-o",
    "-",
    "--quiet",
    "--no-warnings",
  ];

  if (useCookies && YTDLP_COOKIES_PATH) {
    args.push("--cookies", YTDLP_COOKIES_PATH);
    debug("yt-dlp using cookies file");
  }

  if (process.env.YTDLP_PROXY) {
    args.push("--proxy", process.env.YTDLP_PROXY);
    debug("yt-dlp using proxy from YTDLP_PROXY");
  }

  args.push(url);
  return args;
};

const streamWithYtDlp = (url) =>
  new Promise((resolve, reject) => {
    const formatSelectors = getFormatSelectors();
    const useCookieOnly = IS_FLY_RUNTIME && Boolean(YTDLP_COOKIES_PATH);
    const attemptConfigs = useCookieOnly
      ? formatSelectors.map((formatSelector) => ({
          formatSelector,
          useCookies: true,
        }))
      : [
          ...formatSelectors.map((formatSelector) => ({
            formatSelector,
            useCookies: false,
          })),
          ...(YTDLP_COOKIES_PATH
            ? formatSelectors.map((formatSelector) => ({
                formatSelector,
                useCookies: true,
              }))
            : []),
        ];
    let attemptIndex = 0;
    let proc;

    const audioStream = new PassThrough();
    let didResolve = false;
    let gotAudioData = false;
    let stderrBuffer = "";
    let startTimeout;

    const clearStartTimeout = () => {
      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = null;
      }
    };

    const armStartTimeout = () => {
      clearStartTimeout();
      startTimeout = setTimeout(() => {
        fail(
          new Error(
            "Timed out waiting for audio stream from yt-dlp. Verify cookies are valid and not expired.",
          ),
        );
        if (typeof proc?.kill === "function") {
          proc.kill("SIGKILL");
        }
      }, STREAM_START_TIMEOUT_MS);

      if (typeof startTimeout.unref === "function") {
        startTimeout.unref();
      }
    };

    const fail = (error) => {
      clearStartTimeout();
      if (didResolve) {
        audioStream.destroy(error);
        return;
      }

      didResolve = true;
      reject(error);
    };

    const ready = () => {
      clearStartTimeout();
      if (didResolve) {
        return;
      }

      didResolve = true;
      resolve({ stream: audioStream, type: StreamType.Arbitrary, proc });
    };

    const startAttempt = () => {
      const attempt = attemptConfigs[attemptIndex];
      const { formatSelector, useCookies } = attempt;
      stderrBuffer = "";
      gotAudioData = false;
      proc = spawn("yt-dlp", buildYtDlpArgs(url, formatSelector, useCookies));
      debug(
        `yt-dlp using format selector: ${formatSelector} (cookies=${useCookies})`,
      );
      armStartTimeout();

      proc.on("error", fail);

      proc.stderr.on("data", (data) => {
        const line = data.toString().trim();
        if (!line) {
          return;
        }

        stderrBuffer = `${stderrBuffer}\n${line}`.trim();
        stderrBuffer = stderrBuffer.split("\n").slice(-5).join("\n");
        debug(`yt-dlp: ${line}`);
      });

      proc.stdout.once("data", (firstChunk) => {
        gotAudioData = true;
        audioStream.write(firstChunk);
        ready();
        proc.stdout.pipe(audioStream);
      });

      proc.stdout.on("error", fail);

      proc.on("close", (code) => {
        if (didResolve) {
          return;
        }

        const shouldRetry =
          !gotAudioData &&
          attemptIndex < attemptConfigs.length - 1 &&
          (code === 1 ||
            /Requested format is not available|Sign in to confirm you.?re not a bot|This content isn't available, try again later/i.test(
              stderrBuffer,
            ));

        if (shouldRetry) {
          attemptIndex += 1;
          debug("yt-dlp retrying with fallback format selector");
          startAttempt();
          return;
        }

        if (!gotAudioData) {
          const details = stderrBuffer ? ` ${stderrBuffer}` : "";
          fail(
            new Error(
              `yt-dlp exited before audio output (code ${code}).${details}`,
            ),
          );
        }
      });
    };

    startAttempt();
  });

const guildQueues = new Map();
const guildVolumePreferences = new Map();
const DEFAULT_VOLUME = 0.5;
const MIN_VOLUME = 0;
const MAX_VOLUME = 2;

const getPreferredVolume = (guildId) =>
  guildVolumePreferences.get(guildId) ?? DEFAULT_VOLUME;

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

const CONNECT_READY_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;
const MAX_CONNECTION_ATTEMPTS = 2;

const waitForReady = async (connection) => {
  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      CONNECT_READY_TIMEOUT_MS,
    );
    return;
  } catch (error) {
    debug(
      `voice ready timeout, current status: ${connection.state?.status || "unknown"}`,
    );

    if (
      connection.state?.status === VoiceConnectionStatus.Signalling ||
      connection.state?.status === VoiceConnectionStatus.Connecting
    ) {
      connection.rejoin();
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        CONNECT_READY_TIMEOUT_MS,
      );
      return;
    }

    throw error;
  }
};

const buildPlaybackErrorDetail = (error) => {
  const rawMessage = String(error?.message || "");
  if (!rawMessage) {
    return "unknown error";
  }

  if (
    /Cannot find module '@discordjs\/opus'|Cannot find module 'node-opus'|Cannot find module 'opusscript'/i.test(
      rawMessage,
    )
  ) {
    return "missing Opus dependency. Install `opusscript` (or `@discordjs/opus`) and restart the bot";
  }

  if (/Sign in to confirm you.?re not a bot/i.test(rawMessage)) {
    return "YouTube blocked playback from this host. Configure yt-dlp cookies for the deployment";
  }

  if (
    error?.name === "AbortError" ||
    /operation was aborted/i.test(rawMessage)
  ) {
    return null;
  }

  return rawMessage.split("\n")[0].trim();
};

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
    const detailText = buildPlaybackErrorDetail(error);
    if (!detailText) {
      return;
    }

    const detail = `: ${detailText}`;
    queue.textChannel
      .send(`Playback failed${detail}. Skipping to the next track.`)
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
  let streamError = null;

  try {
    nextTrack = queue.tracks.shift();
    if (!nextTrack) {
      cleanupQueue(queue.guildId);
      return;
    }

    queue.currentTrack = nextTrack;
    const stream = await streamWithYtDlp(nextTrack.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
      metadata: nextTrack,
    });

    resource.volume?.setVolume(queue.volume);
    queue.lastResource = resource;

    queue.player.play(resource);
  } catch (error) {
    queue.currentTrack = null;
    shouldRetry = queue.tracks.length > 0;
    streamError = error;
    if (shouldRetry) {
      handleQueueError(
        queue,
        error,
        `failed to start track ${nextTrack?.title || "unknown"}`,
      );
    }
  } finally {
    queue.isProcessing = false;
  }

  if (shouldRetry) {
    await processQueue(queue);
    return;
  }

  if (streamError) {
    throw streamError;
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
    lastAnnouncedTrackUrl: null,
    lastResource: null,
    textChannel,
    tracks: [],
    volume: getPreferredVolume(guildId),
    voiceChannelId,
  };

  player.on(AudioPlayerStatus.Playing, async () => {
    const currentTrack = queue.currentTrack;
    if (!currentTrack || queue.lastAnnouncedTrackUrl === currentTrack.url) {
      return;
    }

    queue.lastAnnouncedTrackUrl = currentTrack.url;
    if (queue.textChannel) {
      await queue.textChannel
        .send(
          `▶️ Now playing: **${currentTrack.title}** (${currentTrack.durationLabel})`,
        )
        .catch(debug);
    }
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (!queue.currentTrack) {
      return;
    }

    queue.currentTrack = null;
    queue.lastAnnouncedTrackUrl = null;
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

  let lastConnectionStatus = "unknown";

  for (let attempt = 1; attempt <= MAX_CONNECTION_ATTEMPTS; attempt += 1) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    queue.connection = connection;

    connection.on("stateChange", (oldState, newState) => {
      debug(`voice state: ${oldState.status} -> ${newState.status}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(
            connection,
            VoiceConnectionStatus.Signalling,
            RECONNECT_TIMEOUT_MS,
          ),
          entersState(
            connection,
            VoiceConnectionStatus.Connecting,
            RECONNECT_TIMEOUT_MS,
          ),
        ]);
      } catch (error) {
        handleQueueError(queue, error, "voice connection disconnected");
        cleanupQueue(queue.guildId);
      }
    });

    try {
      await waitForReady(connection);
      connection.subscribe(queue.player);
      queue.voiceChannelId = voiceChannel.id;
      return connection;
    } catch (error) {
      lastConnectionStatus = connection.state?.status || "unknown";
      debug(error);
      connection.destroy();
      queue.connection = null;

      if (attempt === MAX_CONNECTION_ATTEMPTS) {
        throw new Error(
          `Failed to connect to voice (stuck at ${lastConnectionStatus}). Check bot Connect/Speak permission, avoid Stage channels, and ensure host network allows Discord voice UDP.`,
        );
      }
    }
  }

  throw new Error(
    `Failed to connect to voice (stuck at ${lastConnectionStatus}). Check bot Connect/Speak permission, avoid Stage channels, and ensure host network allows Discord voice UDP.`,
  );
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
  if (voiceChannel.joinable === false) {
    throw new Error(
      "I can't join that voice channel. Check Connect permission.",
    );
  }

  if (voiceChannel.speakable === false) {
    throw new Error(
      "I can't speak in that voice channel. Check Speak permission.",
    );
  }

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

  await ensureConnection(queue, voiceChannel);

  queue.tracks.push(...tracks);
  processQueue(queue).catch((error) => {
    handleQueueError(queue, error, "failed to start playback");
  });

  return {
    started: true,
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

const setVolume = (guildId, volume) => {
  if (Number.isNaN(volume)) {
    throw new Error("Volume must be a number.");
  }

  if (volume < MIN_VOLUME || volume > MAX_VOLUME) {
    throw new Error("Volume must be between 0 and 200.");
  }

  guildVolumePreferences.set(guildId, volume);

  const queue = getQueue(guildId);
  if (queue) {
    queue.volume = volume;
    queue.lastResource?.volume?.setVolume(volume);
  }

  return Math.round(volume * 100);
};

const getVolume = (guildId) => {
  const queue = getQueue(guildId);
  if (queue) {
    return Math.round(queue.volume * 100);
  }

  return Math.round(getPreferredVolume(guildId) * 100);
};

module.exports = {
  cleanupQueue,
  enqueue,
  getNowPlaying,
  getQueue,
  getVolume,
  pause,
  resume,
  setVolume,
  skip,
  stop,
};
