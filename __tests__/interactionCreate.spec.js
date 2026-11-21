const { MessageFlags } = require("discord.js");
const {
  createInteractionCreateHandler,
} = require("../src/handlers/interactionCreate");

describe("music buttons", () => {
  const createMusicPlayer = (overrides = {}) => ({
    getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
    isCurrentControls: jest.fn(() => true),
    skip: jest.fn(),
    stop: jest.fn(),
    togglePause: jest.fn(),
    toggleAutoplay: jest.fn(),
    ...overrides,
  });
  const press = (customId, { voiceChannelId = "voice-1" } = {}) => ({
    customId,
    deferUpdate: jest.fn(() => Promise.resolve()),
    guildId: "guild-1",
    isButton: () => true,
    member: { voice: { channelId: voiceChannelId } },
    message: { id: "msg-1" },
    reply: jest.fn(() => Promise.resolve()),
    update: jest.fn(() => Promise.resolve()),
    user: { username: "bob" },
  });

  it("skips as the presser and acknowledges", async () => {
    const musicPlayer = createMusicPlayer();
    const interaction = press("music:skip");

    await createInteractionCreateHandler({ musicPlayer })(interaction);

    expect(musicPlayer.isCurrentControls).toHaveBeenCalledWith(
      "guild-1",
      "msg-1",
    );
    expect(musicPlayer.skip).toHaveBeenCalledWith("guild-1", "bob");
    expect(interaction.deferUpdate).toHaveBeenCalled();
  });

  it("drops the buttons of an old message without acting", async () => {
    const musicPlayer = createMusicPlayer({
      isCurrentControls: jest.fn(() => false),
    });
    const interaction = press("music:skip");

    await createInteractionCreateHandler({ musicPlayer })(interaction);

    expect(interaction.update).toHaveBeenCalledWith({ components: [] });
    expect(musicPlayer.skip).not.toHaveBeenCalled();
  });

  it("refuses someone outside the bot's voice channel", async () => {
    const musicPlayer = createMusicPlayer();
    const interaction = press("music:stop", { voiceChannelId: "voice-2" });

    await createInteractionCreateHandler({ musicPlayer })(interaction);

    expect(musicPlayer.stop).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("tells only the presser when the action fails", async () => {
    const musicPlayer = createMusicPlayer({
      togglePause: jest.fn(() => {
        throw new Error("Nothing is playing right now.");
      }),
    });
    const interaction = press("music:pause");

    await createInteractionCreateHandler({ musicPlayer })(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Nothing is playing right now.",
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("ignores other components", async () => {
    const musicPlayer = createMusicPlayer();
    const interaction = press("poll:vote");

    await createInteractionCreateHandler({ musicPlayer })(interaction);

    expect(musicPlayer.isCurrentControls).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});
