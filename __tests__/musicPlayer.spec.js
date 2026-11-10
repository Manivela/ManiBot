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

describe("music player", () => {
  beforeEach(() => {
    jest.clearAllMocks();

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
