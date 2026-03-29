const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
const mockCreateAudioResource = jest.fn((stream, options) => ({
  stream,
  options,
}));
const mockEntersState = jest.fn(() => Promise.resolve());
const mockJoinVoiceChannel = jest.fn();
const mockSentryCaptureException = jest.fn();

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
    return {
      on: jest.fn((event, handler) => {
        handlers.set(event, handler);
      }),
      pause: jest.fn(),
      play: jest.fn(() => {
        const handler = handlers.get("playing");
        if (handler) {
          handler();
        }
      }),
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

const loadHandlerWithPlayer = () => {
  const {
    createMessageCreateHandler,
  } = require("../src/handlers/messageCreate");
  const musicPlayer = require("../src/music/player");
  return {
    handler: createMessageCreateHandler({ musicPlayer }),
    musicPlayer,
  };
};

const createConnection = () => ({
  destroy: jest.fn(),
  on: jest.fn(),
  subscribe: jest.fn(),
});

const createMessage = ({ content, voiceChannelId = "voice-1" }) => {
  const send = jest.fn(() => Promise.resolve());
  const guild = {
    id: "guild-1",
    voiceAdapterCreator: {},
  };

  return {
    author: {
      bot: false,
      username: "tester",
    },
    channel: { send },
    content,
    guild,
    member: {
      voice: {
        channel: {
          guild,
          id: voiceChannelId,
        },
      },
    },
  };
};

describe("music command smoke integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();

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
            title: "Smoke Song",
            webpage_url: "https://youtube.com/watch?v=smoke",
            duration: 165,
          }),
        ),
      );
    });
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
    mockJoinVoiceChannel.mockImplementation(() => createConnection());
    mockEntersState.mockResolvedValue(undefined);
  });

  it("handles play then nowplaying with real player internals", async () => {
    const { handler, musicPlayer } = loadHandlerWithPlayer();
    const playMessage = createMessage({ content: "!play smoke test" });

    await handler(playMessage);
    await new Promise((resolve) => setImmediate(resolve));

    expect(playMessage.channel.send).toHaveBeenCalledWith(
      "Queued **Smoke Song** (2:45).",
    );
    expect(playMessage.channel.send).toHaveBeenCalledWith(
      "▶️ Now playing: **Smoke Song** (2:45)",
    );

    const nowPlayingMessage = createMessage({ content: "!nowplaying" });
    nowPlayingMessage.channel.send.mockClear();
    await handler(nowPlayingMessage);

    expect(nowPlayingMessage.channel.send).toHaveBeenCalledWith(
      "▶️ Now playing: **Smoke Song** (2:45)",
    );

    musicPlayer.cleanupQueue("guild-1");
  });

  it("blocks skip from a different voice channel", async () => {
    const { handler, musicPlayer } = loadHandlerWithPlayer();
    const playMessage = createMessage({ content: "!play smoke test" });
    await handler(playMessage);

    const skipMessage = createMessage({
      content: "!skip",
      voiceChannelId: "voice-2",
    });

    await handler(skipMessage);

    expect(skipMessage.channel.send).toHaveBeenCalledWith(
      "Music playback is already active in another voice channel.",
    );

    musicPlayer.cleanupQueue("guild-1");
  });
});
