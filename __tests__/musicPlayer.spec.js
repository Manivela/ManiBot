const { EventEmitter } = require("events");
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} = require("fs");
const { join } = require("path");
const { PassThrough } = require("stream");

// The audio cache lives under os.tmpdir(); give each test its own (setting
// TMPDIR wouldn't reach it: Jest's process.env is a copy).
let mockTmpDir;
jest.mock("os", () => ({
  ...jest.requireActual("os"),
  tmpdir: () => mockTmpDir,
}));
const TEST_ROOT = mkdtempSync(
  join(jest.requireActual("os").tmpdir(), "manibot-test-"),
);
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));
const cacheFolderFiles = () => {
  const dir = join(mockTmpDir, "manibot-audio-cache");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const cachedSongs = () => {
  const dir = join(mockTmpDir, "manibot-audio-cache");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".audio"))
    : [];
};
// Cache writes go through the fs thread pool: spin the loop until one lands,
// giving up after 2s of wall-clock so a slow CI runner still gets time.
const until = async (condition) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) {
    throw new Error("condition never became true");
  }
};

const mockSentryCaptureException = jest.fn();
const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
const mockCreateAudioResource = jest.fn((stream, options) => ({
  stream,
  options,
}));
const mockEntersState = jest.fn(() => Promise.resolve());
const mockJoinVoiceChannel = jest.fn();

jest.mock("@sentry/node", () => ({
  ...jest.requireActual("@sentry/node"), // spans and logs are no-ops without init
  captureException: (...args) => mockSentryCaptureException(...args),
}));

jest.mock("child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
  execFile: (...args) => mockExecFile(...args),
}));

jest.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: {
    Idle: "idle",
    Playing: "playing",
  },
  NoSubscriberBehavior: {
    Pause: "pause",
  },
  VoiceConnectionStatus: {
    Disconnected: "disconnected",
    Signalling: "signalling",
    Connecting: "connecting",
    Ready: "ready",
  },
  createAudioPlayer: jest.fn(() => {
    const handlers = new Map();
    const play = jest.fn(() => {
      const handler = handlers.get("playing");
      if (handler) {
        handler();
      }
    });
    return {
      handlers,
      on: jest.fn((event, handler) => {
        handlers.set(event, handler);
      }),
      pause: jest.fn(),
      play,
      state: { status: "idle" },
      stop: jest.fn(),
      unpause: jest.fn(),
    };
  }),
  StreamType: { Arbitrary: "arbitrary" },
  createAudioResource: (...args) => mockCreateAudioResource(...args),
  entersState: (...args) => mockEntersState(...args),
  joinVoiceChannel: (...args) => mockJoinVoiceChannel(...args),
}));

const loadPlayer = () => require("../src/music/player");

const createFixtures = (voiceChannelId = "voice-1") => {
  const textChannel = {
    send: jest.fn(() => Promise.resolve()),
  };

  const guild = {
    id: "guild-1",
    voiceAdapterCreator: {},
  };

  const voiceChannel = {
    id: voiceChannelId,
    guild,
  };

  return { guild, textChannel, voiceChannel };
};

const createConnection = () => ({
  destroy: jest.fn(),
  on: jest.fn(),
  subscribe: jest.fn(),
});

// A yt-dlp stand-in with real streams, so stdout "end" and process "close"
// fire like the real thing (the audio cache depends on both).
const realisticProc = ({ bytes = "song-bytes", finish = true } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  setImmediate(() => {
    if (!finish) {
      proc.stdout.write(Buffer.from(bytes));
      return;
    }
    proc.stdout.once("end", () => setImmediate(() => proc.emit("close", 0)));
    proc.stdout.end(Buffer.from(bytes));
  });
  return proc;
};

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
};

describe("music player", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // fresh lookup/audio caches per test
    mockTmpDir = mkdtempSync(join(TEST_ROOT, "t-"));
    jest.useRealTimers();

    mockSpawn.mockImplementation(() => {
      const stdoutOn = jest.fn();
      const stdoutOnce = jest.fn((event, handler) => {
        if (event === "data") {
          setImmediate(() => handler(Buffer.from("audio")));
        }
      });
      const proc = {
        on: jest.fn(),
        stdout: {
          on: stdoutOn,
          once: stdoutOnce,
          pipe: jest.fn(),
          destroy: jest.fn(),
        },
        stderr: { on: jest.fn() },
      };
      return proc;
    });
    mockExecFile.mockImplementation((cmd, args, options, callback) => {
      const cb =
        typeof options === "function"
          ? options
          : typeof callback === "function"
            ? callback
            : null;
      if (!cb) {
        throw new Error("execFile mock: expected callback");
      }

      setImmediate(() =>
        cb(
          null,
          JSON.stringify({
            title: "Track A",
            webpage_url: "https://youtube.com/watch?v=abc",
            duration: 201,
          }),
        ),
      );
    });

    mockJoinVoiceChannel.mockImplementation(() => createConnection());
    mockEntersState.mockResolvedValue(undefined);
  });

  it("enqueues and starts playing a resolved video", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    const result = await player.enqueue({
      guild,
      query: "https://youtube.com/watch?v=abc",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(result.tracksAdded).toBe(1);
    expect(result.started).toBe(true);
    expect(mockJoinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "voice-1",
        guildId: "guild-1",
      }),
    );
    expect(mockCreateAudioResource).toHaveBeenCalled();
    expect(textChannel.send).toHaveBeenCalledWith(
      "▶️ Now playing: **Track A** (3:21)",
    );

    player.cleanupQueue(guild.id);
  });

  it("closes yt-dlp's stdout when playback tears the stream down", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    await player.enqueue({
      guild,
      query: "test",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const [stream] = mockCreateAudioResource.mock.calls[0];
    const proc = mockSpawn.mock.results[0].value;
    expect(proc.stdout.destroy).not.toHaveBeenCalled();

    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(proc.stdout.destroy).toHaveBeenCalled();

    player.cleanupQueue(guild.id);
  });

  describe("prefetching the next track", () => {
    const urlOf = (id) => `https://music.youtube.com/watch?v=${id}`;
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const spawnedUrls = () =>
      mockSpawn.mock.calls.map(([, args]) => args.at(-1));
    const enqueuePlaylist = async (player, durations) => {
      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        setImmediate(() =>
          callback(
            null,
            JSON.stringify({
              entries: durations.map((duration, i) => ({
                id: `track${i}`,
                title: `Song ${i}`,
                url: urlOf(`track${i}`),
                duration,
              })),
            }),
          ),
        );
      });
      const fixtures = createFixtures();
      await player.enqueue({
        ...fixtures,
        query: "https://music.youtube.com/playlist?list=x",
        requestedBy: "tester",
      });
      await flush();
      return fixtures.guild;
    };

    it("starts the next track's stream while one plays and reuses it", async () => {
      const player = loadPlayer();
      const guild = await enqueuePlaylist(player, [200, 180]);

      expect(spawnedUrls()).toEqual([urlOf("track0"), urlOf("track1")]);
      const prefetchedStream =
        mockSpawn.mock.results[1].value.stdout.pipe.mock.calls[0][0];

      player.getQueue(guild.id).player.handlers.get("idle")();
      await flush();

      expect(spawnedUrls()).toHaveLength(2);
      expect(mockCreateAudioResource.mock.calls[1][0]).toBe(prefetchedStream);

      player.cleanupQueue(guild.id);
    });

    it("tears down a prefetched stream on stop", async () => {
      const player = loadPlayer();
      const guild = await enqueuePlaylist(player, [200, 180]);
      const prefetchProc = mockSpawn.mock.results[1].value;

      player.stop(guild.id);
      await flush();

      expect(prefetchProc.stdout.destroy).toHaveBeenCalled();
    });

    it.each([
      ["too long to buffer", 3600],
      ["of unknown length", null],
    ])("skips a next track %s", async (_, duration) => {
      const player = loadPlayer();
      const guild = await enqueuePlaylist(player, [200, duration]);

      expect(spawnedUrls()).toEqual([urlOf("track0")]);

      player.cleanupQueue(guild.id);
    });

    it("doesn't prefetch on Fly, whose 768MB can't hold two yt-dlp runs", async () => {
      process.env.FLY_APP_NAME = "manibot";
      jest.resetModules(); // IS_FLY_RUNTIME is read at load
      try {
        const player = loadPlayer();
        const guild = await enqueuePlaylist(player, [200, 180]);

        expect(spawnedUrls()).toEqual([urlOf("track0")]);

        player.cleanupQueue(guild.id);
      } finally {
        delete process.env.FLY_APP_NAME;
      }
    });
  });

  it("supports skip, pause, resume, and stop on active queue", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    await player.enqueue({
      guild,
      query: "test",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });

    const paused = player.pause(guild.id);
    const resumed = player.resume(guild.id);
    const skipped = player.skip(guild.id);

    expect(paused.title).toBe("Track A");
    expect(resumed.title).toBe("Track A");
    expect(skipped.title).toBe("Track A");

    expect(() => player.stop(guild.id)).not.toThrow();
    expect(player.getQueue(guild.id)).toBeNull();
  });

  it("rejects playback control when no track is playing", () => {
    const player = loadPlayer();

    expect(() => player.skip("guild-1")).toThrow(
      "Nothing is playing right now.",
    );
    expect(() => player.pause("guild-1")).toThrow(
      "Nothing is playing right now.",
    );
    expect(() => player.resume("guild-1")).toThrow(
      "Nothing is playing right now.",
    );
    expect(() => player.stop("guild-1")).toThrow(
      "Nothing is playing right now.",
    );
  });

  it("persists guild volume preference across playback sessions", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    expect(player.setVolume(guild.id, 0.7)).toBe(70);
    expect(player.getVolume(guild.id)).toBe(70);

    await player.enqueue({
      guild,
      query: "test",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const queue = player.getQueue(guild.id);
    expect(queue.volume).toBe(0.7);

    player.stop(guild.id);
    expect(player.getVolume(guild.id)).toBe(70);

    await player.enqueue({
      guild,
      query: "test",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(player.getQueue(guild.id).volume).toBe(0.7);

    player.cleanupQueue(guild.id);
  });

  it("rejects enqueue when switching to a different voice channel", async () => {
    const player = loadPlayer();
    const fixtureA = createFixtures("voice-1");
    const fixtureB = createFixtures("voice-2");

    await player.enqueue({
      guild: fixtureA.guild,
      query: "track",
      requestedBy: "tester",
      textChannel: fixtureA.textChannel,
      voiceChannel: fixtureA.voiceChannel,
    });

    await expect(
      player.enqueue({
        guild: fixtureB.guild,
        query: "track",
        requestedBy: "tester",
        textChannel: fixtureB.textChannel,
        voiceChannel: fixtureB.voiceChannel,
      }),
    ).rejects.toThrow(
      "Music playback is already active in another voice channel.",
    );

    player.cleanupQueue(fixtureA.guild.id);
  });

  it("queues every playable entry of a playlist URL", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    mockExecFile.mockImplementation((cmd, args, options, callback) => {
      setImmediate(() =>
        callback(
          null,
          JSON.stringify({
            _type: "playlist",
            entries: [
              {
                id: "aaaaaaaaaaa",
                title: "Song A",
                url: "https://music.youtube.com/watch?v=aaaaaaaaaaa",
                duration: 253,
              },
              {
                id: "bbbbbbbbbbb",
                title: null,
                url: "https://music.youtube.com/watch?v=bbbbbbbbbbb",
                duration: null,
              },
              {
                id: "ccccccccccc",
                title: "Song C",
                url: "https://music.youtube.com/watch?v=ccccccccccc",
                duration: 88,
              },
            ],
          }),
        ),
      );
    });

    const result = await player.enqueue({
      guild,
      query: "https://music.youtube.com/playlist?list=PLA6438AC38AC21D3E",
      requestedBy: "tester",
      textChannel,
      voiceChannel,
    });

    expect(mockExecFile.mock.calls[0][1]).toContain("--flat-playlist");
    expect(result.tracksAdded).toBe(2);
    expect(result.tracks.map((t) => [t.title, t.url, t.durationLabel])).toEqual(
      [
        ["Song A", "https://music.youtube.com/watch?v=aaaaaaaaaaa", "4:13"],
        ["Song C", "https://music.youtube.com/watch?v=ccccccccccc", "1:28"],
      ],
    );

    player.cleanupQueue(guild.id);
  });

  describe("joining voice while the track resolves", () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    // Each yt-dlp metadata call parks here until the test answers it.
    const pendingLookups = [];
    const answer = (callIndex, title) =>
      pendingLookups[callIndex](
        null,
        JSON.stringify({
          title,
          webpage_url: "https://youtube.com/watch?v=x",
          duration: 60,
        }),
      );
    const fail = (callIndex) => {
      const err = new Error("yt-dlp exited with code 1");
      err.stderr = "ERROR: [youtube] no results found for query";
      pendingLookups[callIndex](err);
    };

    beforeEach(() => {
      pendingLookups.length = 0;
      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        pendingLookups.push(callback);
      });
    });

    it("joins before the lookup finishes", async () => {
      const player = loadPlayer();
      const { guild, textChannel, voiceChannel } = createFixtures();

      const playing = player.enqueue({
        guild,
        voiceChannel,
        textChannel,
        query: "song",
        requestedBy: "tester",
      });
      await flush();
      expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);
      expect(pendingLookups).toHaveLength(1); // lookup still running

      answer(0, "Song");
      await expect(playing).resolves.toMatchObject({ tracksAdded: 1 });

      player.cleanupQueue(guild.id);
    });

    it("leaves 30s after a failed lookup if nothing else comes", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      const player = loadPlayer();
      const { guild, textChannel, voiceChannel } = createFixtures();

      const playing = player.enqueue({
        guild,
        voiceChannel,
        textChannel,
        query: "nothing",
        requestedBy: "tester",
      });
      await flush();
      fail(0);

      await expect(playing).rejects.toThrow(
        "No YouTube results found for that query.",
      );
      const connection = mockJoinVoiceChannel.mock.results[0].value;
      jest.advanceTimersByTime(29_000);
      expect(connection.destroy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      expect(connection.destroy).toHaveBeenCalled();
      expect(player.getQueue(guild.id)).toBeNull();
    });

    it("doesn't play into a queue that !stop tore down mid-lookup", async () => {
      const player = loadPlayer();
      const { guild, textChannel, voiceChannel } = createFixtures();

      const playing = player.enqueue({
        guild,
        voiceChannel,
        textChannel,
        query: "song",
        requestedBy: "tester",
      });
      await flush();
      player.stop(guild.id);
      answer(0, "Song");

      await expect(playing).rejects.toThrow(
        "Playback was stopped before that track could start.",
      );
      expect(mockCreateAudioResource).not.toHaveBeenCalled();
      expect(player.getQueue(guild.id)).toBeNull();
    });

    it("a failed !play doesn't tear down another one still resolving", async () => {
      const player = loadPlayer();
      const { guild, textChannel, voiceChannel } = createFixtures();

      const first = player.enqueue({
        guild,
        voiceChannel,
        textChannel,
        query: "good",
        requestedBy: "a",
      });
      const second = player.enqueue({
        guild,
        voiceChannel,
        textChannel,
        query: "typo",
        requestedBy: "b",
      });
      await flush();
      fail(1);
      await expect(second).rejects.toThrow("No YouTube results found");

      const connection = mockJoinVoiceChannel.mock.results[0].value;
      expect(connection.destroy).not.toHaveBeenCalled();

      answer(0, "Good Song");
      await expect(first).resolves.toMatchObject({ tracksAdded: 1 });
      await flush();
      expect(player.getNowPlaying(guild.id)).toMatchObject({
        title: "Good Song",
      });
      expect(connection.destroy).not.toHaveBeenCalled();

      player.cleanupQueue(guild.id);
    });
  });

  describe("caching and staying around", () => {
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const play = (
      player,
      fixtures,
      query = "https://youtube.com/watch?v=abc",
    ) => player.enqueue({ ...fixtures, query, requestedBy: "tester" });
    const endTrack = (player, guild) =>
      player.getQueue(guild.id).player.handlers.get("idle")();

    beforeEach(() => {
      mockSpawn.mockImplementation(() => realisticProc());
    });

    it("plays a repeat from cache without running yt-dlp again", async () => {
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures);
      await until(() => cachedSongs().length === 1);
      endTrack(player, fixtures.guild);
      await flush();
      await play(player, fixtures);
      await flush();

      expect(mockExecFile).toHaveBeenCalledTimes(1); // lookup cached
      expect(mockSpawn).toHaveBeenCalledTimes(1); // audio cached
      expect(await readAll(mockCreateAudioResource.mock.calls[1][0])).toBe(
        "song-bytes",
      );

      player.cleanupQueue(fixtures.guild.id);
    });

    it("caches nothing on Fly, which wipes the machine every night", async () => {
      process.env.FLY_APP_NAME = "manibot";
      try {
        const player = loadPlayer();
        const fixtures = createFixtures();

        await play(player, fixtures);
        await until(() => mockCreateAudioResource.mock.calls.length === 1);
        await readAll(mockCreateAudioResource.mock.calls[0][0]);
        await flush();
        endTrack(player, fixtures.guild);
        await flush();
        await play(player, fixtures);
        await flush();

        expect(cacheFolderFiles()).toEqual([]);
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        player.cleanupQueue(fixtures.guild.id);
      } finally {
        delete process.env.FLY_APP_NAME;
      }
    });

    it("doesn't cache a download cut short, even if yt-dlp exited 0", async () => {
      mockSpawn.mockImplementation(() => realisticProc({ finish: false }));
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures);
      await flush();
      mockCreateAudioResource.mock.calls[0][0].destroy(); // skipped mid-download
      await flush();
      mockSpawn.mock.results[0].value.emit("close", 0);
      endTrack(player, fixtures.guild);
      await flush();

      await until(() => cacheFolderFiles().length === 0); // temp file removed too
      expect(cacheFolderFiles()).toEqual([]);
      mockSpawn.mockImplementation(() => realisticProc());
      await play(player, fixtures);
      await flush();
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      player.cleanupQueue(fixtures.guild.id);
    });

    it("caches a long track too (no in-memory size cap)", async () => {
      const long = Buffer.alloc(20 * 1024 * 1024, 7); // over the old 16MB cap
      mockSpawn.mockImplementation(() => realisticProc({ bytes: long }));
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures);
      await until(() => mockCreateAudioResource.mock.calls.length === 1);
      const playback = readAll(mockCreateAudioResource.mock.calls[0][0]); // drains like the voice player
      await until(() => cachedSongs().length === 1);
      await playback;

      const [song] = cachedSongs();
      expect(statSync(join(mockTmpDir, "manibot-audio-cache", song)).size).toBe(
        long.length,
      );

      player.cleanupQueue(fixtures.guild.id);
    });

    it("keeps cached songs across a restart", async () => {
      const fixtures = createFixtures();
      let player = loadPlayer();
      await play(player, fixtures);
      await until(() => cachedSongs().length === 1);
      player.cleanupQueue(fixtures.guild.id);

      jest.resetModules(); // the bot restarts; same cache folder
      player = loadPlayer();
      await play(player, fixtures);
      await flush();

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(await readAll(mockCreateAudioResource.mock.calls[1][0])).toBe(
        "song-bytes",
      );

      player.cleanupQueue(fixtures.guild.id);
    });

    it("plays the same song twice in a row", async () => {
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures);
      await play(player, fixtures); // queued while the first plays
      await until(() => cachedSongs().length === 1);
      endTrack(player, fixtures.guild);
      await flush();

      expect(mockCreateAudioResource).toHaveBeenCalledTimes(2);
      expect(await readAll(mockCreateAudioResource.mock.calls[1][0])).toBe(
        "song-bytes",
      );

      player.cleanupQueue(fixtures.guild.id);
    });

    it("reuses a search lookup regardless of case and spacing", async () => {
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures, "Some  Song");
      await flush();
      endTrack(player, fixtures.guild);
      await play(player, fixtures, "some song");

      expect(mockExecFile).toHaveBeenCalledTimes(1);

      player.cleanupQueue(fixtures.guild.id);
    });

    it("looks search text up again after a day", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures, "some song");
      await flush();
      endTrack(player, fixtures.guild);
      jest.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      await play(player, fixtures, "some song");

      expect(mockExecFile).toHaveBeenCalledTimes(2);

      player.cleanupQueue(fixtures.guild.id);
    });

    it("stays in voice 30s after the queue ends, so a !play reuses the connection", async () => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
      const player = loadPlayer();
      const fixtures = createFixtures();

      await play(player, fixtures);
      await flush();
      endTrack(player, fixtures.guild);
      await flush();
      const connection = mockJoinVoiceChannel.mock.results[0].value;

      jest.advanceTimersByTime(20_000);
      expect(connection.destroy).not.toHaveBeenCalled();
      await play(player, fixtures);
      await flush();
      expect(mockJoinVoiceChannel).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_000); // playing again: the old timer must not fire
      expect(connection.destroy).not.toHaveBeenCalled();

      endTrack(player, fixtures.guild);
      await flush();
      jest.advanceTimersByTime(30_000);
      expect(connection.destroy).toHaveBeenCalled();
      expect(player.getQueue(fixtures.guild.id)).toBeNull();
    });

    const mockTwoSongPlaylist = () =>
      mockExecFile.mockImplementation((cmd, args, options, callback) => {
        setImmediate(() =>
          callback(
            null,
            JSON.stringify({
              entries: [0, 1].map((i) => ({
                id: `track${i}`,
                title: `Song ${i}`,
                url: `https://music.youtube.com/watch?v=track${i}`,
                duration: 60,
              })),
            }),
          ),
        );
      });
    const human = { user: { bot: false } };
    const bot = { user: { bot: true } };

    it("keeps playing for people in the channel the bot was dragged to", async () => {
      mockTwoSongPlaylist();
      const player = loadPlayer();
      const fixtures = createFixtures();
      fixtures.voiceChannel.members = [human, bot];

      await play(player, fixtures, "https://music.youtube.com/playlist?list=x");
      await flush();
      fixtures.voiceChannel.members = []; // old channel empty: bot was dragged
      fixtures.guild.members = {
        me: { voice: { channel: { members: [human, bot] } } },
      };
      endTrack(player, fixtures.guild);
      await flush();

      expect(mockCreateAudioResource).toHaveBeenCalledTimes(2);
      expect(player.getQueue(fixtures.guild.id)).not.toBeNull();

      player.cleanupQueue(fixtures.guild.id);
    });

    it("leaves before the next song when nobody is left in voice", async () => {
      mockTwoSongPlaylist();
      const player = loadPlayer();
      const fixtures = createFixtures();
      fixtures.voiceChannel.members = [human, bot];

      await play(player, fixtures, "https://music.youtube.com/playlist?list=x");
      await flush();
      fixtures.voiceChannel.members = [bot]; // the human left
      endTrack(player, fixtures.guild);
      await flush();

      expect(mockCreateAudioResource).toHaveBeenCalledTimes(1);
      expect(
        mockJoinVoiceChannel.mock.results[0].value.destroy,
      ).toHaveBeenCalled();
      expect(player.getQueue(fixtures.guild.id)).toBeNull();
      expect(fixtures.textChannel.send).toHaveBeenCalledWith(
        expect.stringMatching(/Everyone left/),
      );
    });
  });

  it("throws clear error when search returns no results", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    mockExecFile.mockImplementation((cmd, args, options, callback) => {
      const cb =
        typeof options === "function"
          ? options
          : typeof callback === "function"
            ? callback
            : null;
      if (!cb) {
        throw new Error("execFile mock: expected callback");
      }

      setImmediate(() => {
        const err = new Error("yt-dlp exited with code 1");
        err.stderr = "ERROR: [youtube] no results found for query";
        cb(err);
      });
    });

    await expect(
      player.enqueue({
        guild,
        query: "query-without-results",
        requestedBy: "tester",
        textChannel,
        voiceChannel,
      }),
    ).rejects.toThrow("No YouTube results found for that query.");
  });
});
