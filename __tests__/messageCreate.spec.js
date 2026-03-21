const {
  buildQueueMessage,
  buildVersionMessage,
  createMessageCreateHandler,
} = require("../src/handlers/messageCreate");

describe("Message Create Handler", () => {
  const queueTrack = {
    title: "Test Song",
    durationLabel: "3:10",
  };

  const createMessage = ({
    content,
    voiceChannelId = "voice-1",
    authorBot = false,
  }) => {
    const send = jest.fn(() => Promise.resolve());

    return {
      author: {
        bot: authorBot,
        username: "tester",
      },
      channel: { send },
      content,
      guild: { id: "guild-1" },
      member: {
        voice: voiceChannelId
          ? {
              channel: { id: voiceChannelId },
            }
          : {},
      },
    };
  };

  it("responds to ping", async () => {
    const musicPlayer = { getQueue: jest.fn() };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "ping" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith("pong");
  });

  it("queues a track from the caller's voice channel", async () => {
    const musicPlayer = {
      enqueue: jest.fn(() =>
        Promise.resolve({
          tracks: [queueTrack],
          tracksAdded: 1,
        }),
      ),
      getQueue: jest.fn(() => null),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!play never gonna give you up" });

    await handler(msg);

    expect(musicPlayer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        guild: msg.guild,
        query: "never gonna give you up",
        requestedBy: "tester",
        textChannel: msg.channel,
        voiceChannel: { id: "voice-1" },
      }),
    );
    expect(msg.channel.send).toHaveBeenCalledWith(
      "Queued **Test Song** (3:10).",
    );
  });

  it("requires a voice channel for play", async () => {
    const musicPlayer = {
      enqueue: jest.fn(),
      getQueue: jest.fn(() => null),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!play test", voiceChannelId: null });

    await handler(msg);

    expect(musicPlayer.enqueue).not.toHaveBeenCalled();
    expect(msg.channel.send).toHaveBeenCalledWith(
      "Join a voice channel first.",
    );
  });

  it("skips the current song when the caller is in the active channel", async () => {
    const musicPlayer = {
      getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
      skip: jest.fn(() => queueTrack),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!skip" });

    await handler(msg);

    expect(musicPlayer.skip).toHaveBeenCalledWith("guild-1");
    expect(msg.channel.send).toHaveBeenCalledWith("Skipped **Test Song**.");
  });

  it("renders the queue summary", () => {
    const message = buildQueueMessage({
      currentTrack: queueTrack,
      tracks: [{ title: "Next Song", durationLabel: "4:20" }],
    });

    expect(message).toContain("Now playing");
    expect(message).toContain("Next Song");
  });

  it("returns the bot version", async () => {
    const musicPlayer = { getQueue: jest.fn() };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!version" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(buildVersionMessage());
  });

  it("includes build fingerprint in version output", () => {
    const message = buildVersionMessage();

    expect(message).toContain("Version:");
    expect(message).toContain("Build:");
  });

  it("lists version in help output", async () => {
    const musicPlayer = { getQueue: jest.fn() };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!help" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("!version"),
    );
  });
});
