const mockSentryCaptureException = jest.fn();
const mockSpawn = jest.fn();
const mockPlayValidate = jest.fn();
const mockPlayVideoInfo = jest.fn();
const mockPlayPlaylistInfo = jest.fn();
const mockPlaySearch = jest.fn();
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
}));

jest.mock("play-dl", () => ({
  yt_validate: (...args) => mockPlayValidate(...args),
  video_basic_info: (...args) => mockPlayVideoInfo(...args),
  playlist_info: (...args) => mockPlayPlaylistInfo(...args),
  search: (...args) => mockPlaySearch(...args),
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
    jest.resetModules();
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
        stdout: { on: stdoutOn, once: stdoutOnce, pipe: jest.fn() },
        stderr: { on: jest.fn() },
      };
      return proc;
    });
    mockPlayValidate.mockReturnValue("video");
    mockPlayVideoInfo.mockResolvedValue({
      video_details: {
        durationRaw: ["3", "21"],
        title: "Track A",
        url: "https://youtube.com/watch?v=abc",
      },
    });
    mockPlayPlaylistInfo.mockReset();
    mockPlaySearch.mockReset();

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

  it("throws clear error when search returns no results", async () => {
    const player = loadPlayer();
    const { guild, textChannel, voiceChannel } = createFixtures();

    mockPlayValidate.mockReturnValue("search");
    mockPlaySearch.mockResolvedValue([]);

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
