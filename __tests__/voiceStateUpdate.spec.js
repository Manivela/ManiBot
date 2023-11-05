const { ChannelType } = require("discord.js");
const { voiceStateUpdateHandler } = require("../src/handlers/voiceStateUpdate");

describe("Voice State Update Handler", () => {
  const everyoneRole = {
    id: "everyoneRoleId",
  };
  const voiceChannel = {
    name: "General",
    parent: {
      children: { create: jest.fn(() => Promise.resolve(textChannel)) },
    },
    delete: jest.fn(() => Promise.resolve()),
    members: { size: 0 },
  };
  const guild = {
    channels: { cache: [voiceChannel] },
    roles: {
      everyone: everyoneRole,
      cache: [],
      fetch: jest.fn(),
    },
  };
  const member = {
    id: "testMemberId",
    displayName: "TestMember",
  };
  const permissionOverwrites = {
    delete: jest.fn(() => Promise.resolve(textChannel)),
    create: jest.fn(() => Promise.resolve(textChannel)),
  };
  const textChannel = {
    name: "general-manibot",
    type: ChannelType.GuildText,
    delete: jest.fn(() => Promise.resolve(textChannel)),
    permissionOverwrites,
  };
  const client = { user: { id: "botId" } };

  afterEach(() => {
    // never delete the voice channel
    expect(voiceChannel.delete).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it("creates a text channel when someone joins a voice channel", async () => {
    jest.replaceProperty(voiceChannel.members, "size", 1);
    const oldState = { guild, member, channel: null };
    const newState = { guild, member, channel: voiceChannel };
    await voiceStateUpdateHandler(oldState, newState, client);
    expect(newState.channel.parent.children.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: textChannel.name,
        type: textChannel.type,
      })
    );
  });
  it("doesn't do anything if the member is still in the channel", async () => {
    const oldState = { guild, member, channel: voiceChannel };
    const newState = { guild, member, channel: voiceChannel };
    await voiceStateUpdateHandler(oldState, newState, client);
    expect(newState.channel.parent.children.create).not.toHaveBeenCalled();
  });
  it("removes the text channel when everyone leaves the voice channel", async () => {
    jest.replaceProperty(guild.channels, "cache", [textChannel]);
    const oldState = { guild, member, channel: voiceChannel };
    const newState = { guild, member, channel: null };
    await voiceStateUpdateHandler(oldState, newState, client);
    expect(textChannel.delete).toHaveBeenCalled();
  });
});
