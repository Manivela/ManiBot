const { execFile, spawn } = require("child_process");
const { createHash } = require("crypto");
const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimes,
  writeFileSync,
} = require("fs");
const { rename, rm } = require("fs/promises");
const { setPriority, tmpdir } = require("os");
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
const volumeStore = require("./volumeStore");
const { createLru } = require("../utils/lru");

const YTDLP_METADATA_TIMEOUT_MS = 90_000;

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
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const IS_FLY_RUNTIME = Boolean(
  process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID,
);

// yt-dlp needs --js-runtimes repeated once per runtime (a comma-joined value is
// rejected). Expand "deno,node" into ["--js-runtimes", "deno", "--js-runtimes", "node"]
// so the preference list (deno first, node fallback) is honoured.
const buildJsRuntimeArgs = () => {
  const raw = process.env.YTDLP_JS_RUNTIME || "node";
  return raw
    .split(",")
    .map((runtime) => runtime.trim())
    .filter(Boolean)
    .flatMap((runtime) => ["--js-runtimes", runtime]);
};

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
    ...buildJsRuntimeArgs(),
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

const buildYtDlpMetadataArgs = (target) => {
  const args = [
    ...buildJsRuntimeArgs(),
    "--dump-single-json",
    "--flat-playlist",
    "--no-download",
    "--quiet",
    "--no-warnings",
  ];

  if (YTDLP_COOKIES_PATH) {
    args.push("--cookies", YTDLP_COOKIES_PATH);
  }

  if (process.env.YTDLP_PROXY) {
    args.push("--proxy", process.env.YTDLP_PROXY);
  }

  args.push(target);
  return args;
};

const formatSecondsAsDurationLabel = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "live";
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
};

const isTemporaryYoutubeMediaUrl = (value) =>
  typeof value === "string" &&
  (/googlevideo\.com/i.test(value) || /manifest\.googlevideo/i.test(value));

const resolvePlaybackUrl = (entry) => {
  const id = typeof entry.id === "string" ? entry.id : null;

  for (const candidate of [
    entry.webpage_url,
    entry.original_url,
    entry.url,
  ]) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }

    const u = candidate.trim();

    if (isTemporaryYoutubeMediaUrl(u)) {
      continue;
    }

    if (/^https?:\/\//i.test(u)) {
      return u;
    }

    if (u.startsWith("/")) {
      try {
        return new URL(u, "https://www.youtube.com").href;
      } catch {
        continue;
      }
    }
  }

  if (id && /^[\w-]{11}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }

  return null;
};

const ytDlpEntryToTrackFields = (entry) => {
  const url = resolvePlaybackUrl(entry);
  if (!url) {
    return null;
  }

  const isLive = entry.is_live || entry.live_status === "is_live";
  const durationRaw = isLive
    ? "live"
    : entry.duration === undefined || entry.duration === null
      ? "0:00"
      : formatSecondsAsDurationLabel(entry.duration);

  return {
    title: entry.title || "Unknown title",
    url,
    durationRaw,
    durationSeconds:
      !isLive && Number.isFinite(entry.duration) ? entry.duration : null,
  };
};

const tracksFromYtDlpMetadata = (data) => {
  if (!data || typeof data !== "object") {
    return [];
  }

  if (Array.isArray(data.entries) && data.entries.length > 0) {
    // --flat-playlist lists unavailable/private videos as title-less stubs.
    return data.entries
      .filter((entry) => entry?.title)
      .map(ytDlpEntryToTrackFields)
      .filter(Boolean);
  }

  const single = ytDlpEntryToTrackFields(data);
  return single ? [single] : [];
};

const runYtDlpMetadataJson = (target) =>
  new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      buildYtDlpMetadataArgs(target),
      {
        maxBuffer: 50 * 1024 * 1024,
        timeout: YTDLP_METADATA_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr !== undefined && stderr !== null) {
            err.stderr = stderr;
          }

          reject(err);
          return;
        }

        resolve(stdout);
      },
    );
  });

// Fits a whole PREFETCH_MAX_SECONDS track (format 251 is ~1MB/min).
const STREAM_BUFFER_BYTES = 16 * 1024 * 1024;

// Finished downloads, so a repeat skips yt-dlp. Values are file sizes.
const AUDIO_CACHE_DIR = join(tmpdir(), "manibot-audio-cache");
const audioCachePath = (key) => join(AUDIO_CACHE_DIR, `${key}.audio`);
const audioCache = createLru(
  5 * 1024 ** 3,
  (size) => size,
  (key) => rm(audioCachePath(key), { force: true }).catch(debug),
);

// Rebuild the index from disk, oldest first; drop leftover partial writes.
try {
  readdirSync(AUDIO_CACHE_DIR)
    .flatMap((name) => {
      const path = join(AUDIO_CACHE_DIR, name);
      if (!name.endsWith(".audio")) {
        rmSync(path, { force: true });
        return [];
      }
      const { size, mtimeMs } = statSync(path);
      return [{ key: name.slice(0, -".audio".length), size, mtimeMs }];
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .forEach(({ key, size }) => audioCache.set(key, size));
} catch (error) {
  if (error.code !== "ENOENT") {
    debug("audio cache unreadable: %s", error.message);
  }
}

// Only stops a live stream filling the disk (~8h of format 251). Off on Fly,
// whose machine is deleted every night.
const MAX_CACHED_TRACK_BYTES = IS_FLY_RUNTIME ? 0 : 512 * 1024 * 1024;

// !play text or link -> track. Search results can change, so they expire.
const lookupCache = createLru(500);
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The YouTube video ID for any link form, else a hash of the URL.
const audioCacheKey = (url) =>
  url.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/)?.[1] ||
  `url-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;

const streamWithYtDlp = (url, { lowPriority = false } = {}) =>
  new Promise((resolve, reject) => {
    const cacheKey = audioCacheKey(url);
    if (audioCache.get(cacheKey)) {
      const path = audioCachePath(cacheKey);
      if (existsSync(path)) {
        const now = new Date();
        utimes(path, now, now, () => {}); // recency survives a restart
        resolve({
          stream: createReadStream(path),
          type: StreamType.Arbitrary,
          proc: null,
        });
        return;
      }
      audioCache.delete(cacheKey); // removed behind our back: fetch it again
    }

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

    const audioStream = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    // On skip/stop, close yt-dlp's stdout so it exits (EPIPE) instead of
    // blocking forever on a pipe nobody reads.
    audioStream.once("close", () => proc?.stdout?.destroy());
    let didResolve = false;
    let gotAudioData = false;
    let stderrBuffer = "";
    let startTimeout;
    // Streamed to a temp file and renamed into the cache only when complete.
    let cacheWriter = null;
    let cacheBytes = 0;
    let cacheAbandoned = false;
    let stdoutEnded = false;
    const abandonCache = () => {
      cacheAbandoned = true;
      if (cacheWriter) {
        const temporary = cacheWriter.path;
        cacheWriter.destroy();
        rm(temporary, { force: true }).catch(debug);
        cacheWriter = null;
      }
    };
    const collectForCache = (chunk) => {
      if (cacheAbandoned) {
        return;
      }
      cacheBytes += chunk.length;
      if (cacheBytes > MAX_CACHED_TRACK_BYTES) {
        abandonCache();
        return;
      }
      if (!cacheWriter) {
        try {
          mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
        } catch (error) {
          debug("audio cache unwritable: %s", error.message);
          abandonCache();
          return;
        }
        cacheWriter = createWriteStream(
          `${audioCachePath(cacheKey)}.${process.pid}-${Date.now()}.tmp`,
        );
        cacheWriter.on("error", (error) => {
          debug("audio cache write failed: %s", error.message);
          abandonCache();
        });
      }
      cacheWriter.write(chunk);
    };
    const keepInCache = () => {
      const writer = cacheWriter;
      const size = cacheBytes;
      cacheWriter = null;
      writer.end(() =>
        rename(writer.path, audioCachePath(cacheKey))
          .then(() => audioCache.set(cacheKey, size))
          .catch((error) => {
            debug("could not cache %s: %s", cacheKey, error.message);
            return rm(writer.path, { force: true });
          })
          .catch(debug),
      );
    };

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
      cacheWriter = null;
      cacheBytes = 0;
      cacheAbandoned = false;
      stdoutEnded = false;
      proc = spawn(YTDLP_BIN, buildYtDlpArgs(url, formatSelector, useCookies));
      if (lowPriority && proc.pid) {
        // Let playback win the CPU; children inherit the niceness.
        try {
          setPriority(proc.pid, 19);
        } catch (error) {
          debug("could not lower yt-dlp priority", error);
        }
      }
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

      proc.stdout.on("data", collectForCache);
      proc.stdout.once("end", () => {
        stdoutEnded = true;
      });

      proc.stdout.once("data", (firstChunk) => {
        gotAudioData = true;
        audioStream.write(firstChunk);
        ready();
        proc.stdout.pipe(audioStream);
      });

      proc.stdout.on("error", fail);

      proc.on("close", (code) => {
        // Complete only if yt-dlp exited 0 AND we read stdout to the end.
        if (code === 0 && stdoutEnded && cacheWriter && !cacheAbandoned) {
          keepInCache();
        } else {
          abandonCache();
        }

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
const OPUS_BITRATE = 192_000;
const MIN_VOLUME = 0;
const MAX_VOLUME = 2;

const getPreferredVolume = (guildId) =>
  guildVolumePreferences.get(guildId) ?? DEFAULT_VOLUME;

const clampVolume = (volume) =>
  Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, volume));

// Load persisted per-guild volume preferences into the in-memory cache. Call
// once at startup before the bot serves commands. Safe to call when storage is
// disabled (resolves with nothing applied) and never throws.
const hydratePreferredVolumes = async () => {
  try {
    const stored = await volumeStore.load();
    for (const [guildId, volume] of stored) {
      if (!Number.isFinite(volume)) {
        continue;
      }
      guildVolumePreferences.set(guildId, clampVolume(volume));
    }
    debug(
      "hydrated %d guild volume preference(s)",
      guildVolumePreferences.size,
    );
  } catch (error) {
    debug("failed to hydrate volume preferences", error);
    Sentry.captureException(error);
  }
};

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
  durationSeconds: track.durationSeconds ?? null,
  requestedBy,
});

// Start the next track's stream while the current one plays, if it fits in
// STREAM_BUFFER_BYTES.
const PREFETCH_MAX_SECONDS = 10 * 60;

const prefetchNext = (queue) => {
  const next = queue.tracks[0];
  if (
    IS_FLY_RUNTIME || // its 768MB can't hold two yt-dlp runs at once
    !next ||
    next.prefetch ||
    !(next.durationSeconds > 0 && next.durationSeconds <= PREFETCH_MAX_SECONDS)
  ) {
    return;
  }

  next.prefetch = streamWithYtDlp(next.url, { lowPriority: true });
  next.prefetch.then(
    // Nobody consumes the stream until its turn; keep a late error from crashing us.
    ({ stream }) => stream.on("error", debug),
    (error) => debug("prefetch failed for %s: %s", next.title, error?.message),
  );
};

// A failed prefetch falls back to a fresh stream.
const openTrackStream = async (track) => {
  if (track.prefetch) {
    try {
      return await track.prefetch;
    } catch (error) {
      debug("prefetch unusable, restarting stream: %s", error?.message);
    }
  }

  return streamWithYtDlp(track.url);
};

const clearTracks = (queue) => {
  for (const track of queue.tracks) {
    track.prefetch?.then(
      ({ stream }) => stream.destroy(),
      () => {},
    );
  }
  queue.tracks = [];
};

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

  clearTimeout(queue.idleTimer);
  clearTracks(queue);
  queue.currentTrack = null;

  if (queue.connection) {
    queue.connection.destroy();
  }

  guildQueues.delete(guildId);
};

// Any non-bot left in the bot's current voice channel? Unknown counts as yes.
const hasListeners = (queue) => {
  const channel =
    queue.voiceChannel?.guild?.members?.me?.voice?.channel ??
    queue.voiceChannel;
  const members = channel?.members;
  return !members || members.some((member) => !member.user?.bot);
};

const IDLE_LEAVE_MS = 30_000;

// Linger before leaving so a follow-up !play reuses the connection.
const leaveWhenIdle = (queue) => {
  clearTimeout(queue.idleTimer);
  queue.idleTimer = setTimeout(() => {
    if (
      getQueue(queue.guildId) === queue &&
      !queue.currentTrack &&
      !queue.tracks.length &&
      !queue.pendingEnqueues
    ) {
      cleanupQueue(queue.guildId);
    }
  }, IDLE_LEAVE_MS);
  queue.idleTimer.unref?.();
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

  // Checked before every song: don't play on to an empty channel.
  if (!hasListeners(queue)) {
    if (queue.tracks.length) {
      queue.textChannel
        ?.send(
          "Everyone left the voice channel, so I stopped and cleared the queue.",
        )
        .catch(debug);
    }
    cleanupQueue(queue.guildId);
    return;
  }

  queue.isProcessing = true;
  let shouldRetry = false;
  let nextTrack = null;
  let streamError = null;

  try {
    nextTrack = queue.tracks.shift();
    if (!nextTrack) {
      leaveWhenIdle(queue);
      return;
    }

    queue.currentTrack = nextTrack;
    const stream = await openTrackStream(nextTrack);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
      metadata: nextTrack,
    });

    resource.volume?.setVolume(queue.volume);
    // Volume control re-encodes, and libopus's default (~99kbps) loses detail.
    // prism's setBitrate caps at 128k, so set it on the encoder itself.
    resource.encoder?.encoder.setBitrate(OPUS_BITRATE);
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

const createQueue = ({ guildId, textChannel, voiceChannel }) => {
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
    voiceChannel,
    voiceChannelId: voiceChannel.id,
  };

  player.on(AudioPlayerStatus.Playing, async () => {
    prefetchNext(queue);
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
      leaveWhenIdle(queue);
    });
  });

  player.on("error", (error) => {
    queue.currentTrack = null;
    handleQueueError(queue, error, "audio player emitted an error");
    processQueue(queue).catch((processError) => {
      handleQueueError(queue, processError, "failed after audio player error");
      leaveWhenIdle(queue);
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
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("No YouTube results found for that query.");
  }

  const isUrl = /^https?:\/\//i.test(trimmed);
  const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;
  const cacheKey = isUrl ? trimmed : trimmed.toLowerCase().replace(/\s+/g, " ");
  const hit = lookupCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return [normalizeTrack(hit.track, requestedBy)];
  }

  let data;
  try {
    const stdout = await runYtDlpMetadataJson(target);
    data = JSON.parse(String(stdout).trim());
  } catch (error) {
    const stderr = error.stderr?.toString?.() || "";
    if (/no results found|No matching entries|did not match any videos/i.test(stderr)) {
      throw new Error("No YouTube results found for that query.");
    }

    const firstStderrLine = stderr.trim().split("\n").filter(Boolean)[0] || "";
    const cookieHint =
      /Sign in to confirm|not a bot|login|Private video|Video unavailable/i.test(
        stderr,
      )
        ? " If YouTube is blocking this host, set the YTDLP_COOKIES secret (see README)."
        : "";

    throw new Error(
      `Could not resolve that track.${cookieHint}${
        firstStderrLine ? ` ${firstStderrLine}` : ""
      }`,
    );
  }

  const rawTracks = tracksFromYtDlpMetadata(data);
  if (!rawTracks.length) {
    throw new Error("No YouTube results found for that query.");
  }

  // Playlists change, so only single-track results are kept.
  if (rawTracks.length === 1) {
    lookupCache.set(cacheKey, {
      track: rawTracks[0],
      expiresAt: isUrl ? Infinity : Date.now() + SEARCH_CACHE_TTL_MS,
    });
  }

  return rawTracks.map((track) => normalizeTrack(track, requestedBy));
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

  const queue =
    getQueue(guild.id) ||
    createQueue({ guildId: guild.id, textChannel, voiceChannel });

  queue.textChannel = textChannel;

  // Join voice while the track resolves; wait for both (leaving mid-join
  // would race the connection retry).
  queue.pendingEnqueues = (queue.pendingEnqueues ?? 0) + 1;
  const [lookup, connect] = await Promise.allSettled([
    resolveTracks(query, requestedBy),
    ensureConnection(queue, voiceChannel),
  ]);
  queue.pendingEnqueues -= 1;

  // !stop or a voice disconnect may have torn this queue down meanwhile.
  const stillCurrent = getQueue(guild.id) === queue;
  const tracks = lookup.status === "fulfilled" ? lookup.value : [];
  const failure =
    lookup.status === "rejected"
      ? lookup.reason
      : connect.status === "rejected"
        ? connect.reason
        : !stillCurrent
          ? new Error("Playback was stopped before that track could start.")
          : !tracks.length
            ? new Error("No playable tracks were found.")
            : null;
  if (failure) {
    if (
      stillCurrent &&
      !queue.pendingEnqueues &&
      !queue.currentTrack &&
      !queue.tracks.length
    ) {
      leaveWhenIdle(queue);
    }
    throw failure;
  }

  queue.tracks.push(...tracks);
  if (queue.player.state.status === AudioPlayerStatus.Playing) {
    prefetchNext(queue);
  }
  processQueue(queue).catch((error) => {
    handleQueueError(queue, error, "failed to start playback");
    leaveWhenIdle(queue);
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

  clearTracks(queue);
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
  // Fire-and-forget: volumeStore.save swallows its own errors, so a flaky
  // backend never blocks or breaks the command.
  volumeStore.save(guildId, volume);

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
  hydratePreferredVolumes,
  pause,
  resume,
  setVolume,
  skip,
  stop,
};
