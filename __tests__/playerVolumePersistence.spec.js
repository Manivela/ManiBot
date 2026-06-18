const mockLoad = jest.fn(() => Promise.resolve(new Map()));
const mockSave = jest.fn(() => Promise.resolve());

jest.mock("@sentry/node", () => ({ captureException: jest.fn() }));

jest.mock("../src/music/volumeStore", () => ({
  isEnabled: jest.fn(() => true),
  load: (...args) => mockLoad(...args),
  save: (...args) => mockSave(...args),
}));

// player.js destructures from @discordjs/voice at load time; a light stub keeps
// the heavy voice/native deps out of this unit test.
jest.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
  NoSubscriberBehavior: { Pause: "pause" },
  VoiceConnectionStatus: {},
  StreamType: {},
  createAudioPlayer: jest.fn(),
  createAudioResource: jest.fn(),
  entersState: jest.fn(),
  joinVoiceChannel: jest.fn(),
}));

const loadPlayer = () => require("../src/music/player");

describe("player volume persistence", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockLoad.mockResolvedValue(new Map());
    mockSave.mockResolvedValue();
  });

  it("hydrates stored preferences into getVolume", async () => {
    mockLoad.mockResolvedValue(new Map([["guild-1", 0.7]]));
    const player = loadPlayer();

    await player.hydratePreferredVolumes();

    expect(player.getVolume("guild-1")).toBe(70);
  });

  it("clamps out-of-range stored preferences on hydrate", async () => {
    mockLoad.mockResolvedValue(
      new Map([
        ["too-loud", 5],
        ["negative", -1],
      ]),
    );
    const player = loadPlayer();

    await player.hydratePreferredVolumes();

    expect(player.getVolume("too-loud")).toBe(200);
    expect(player.getVolume("negative")).toBe(0);
  });

  it("falls back to the default volume for unknown guilds", async () => {
    const player = loadPlayer();

    await player.hydratePreferredVolumes();

    expect(player.getVolume("never-seen")).toBe(50);
  });

  it("persists the preference when volume is set", () => {
    const player = loadPlayer();

    expect(player.setVolume("guild-1", 1.2)).toBe(120);
    expect(mockSave).toHaveBeenCalledWith("guild-1", 1.2);
  });

  it("never rejects when the store fails, and keeps defaults", async () => {
    mockLoad.mockRejectedValue(new Error("boom"));
    const player = loadPlayer();

    await expect(
      player.hydratePreferredVolumes(),
    ).resolves.toBeUndefined();
    expect(player.getVolume("guild-1")).toBe(50);
  });
});
