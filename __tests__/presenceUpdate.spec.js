const { ActivityType, ChannelType, Collection } = require("discord.js");

const role = (id, name, permissions = 0n) => ({
  id,
  name,
  editable: true,
  managed: false,
  guild: { id: "guild-1" },
  permissions: { bitfield: permissions },
});
const collection = (items) => new Collection(items.map((i) => [i.id, i]));

describe("Presence Update Handler", () => {
  let presenceUpdateHandler;
  let store;
  let guild;
  let botChannel;

  const osu = { applicationId: "app-osu", name: "osu!" };
  const playing = (activity) => ({ type: ActivityType.Playing, ...activity });

  const createMember = (id = "member-1", roles = []) => ({
    id,
    displayName: id,
    user: { bot: false, username: id },
    roles: { cache: collection(roles), add: jest.fn(), remove: jest.fn() },
  });

  const update = (member, activities) =>
    presenceUpdateHandler(null, { guild, member, activities });

  beforeEach(() => {
    jest.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    ({ presenceUpdateHandler } = require("../src/handlers/presenceUpdate"));
    store = require("../src/games/store");
    botChannel = {
      id: "bot-channel",
      send: jest.fn(() => Promise.resolve({ id: "proposal-1" })),
      permissionsFor: () => ({ has: () => true }),
    };
    guild = {
      id: "guild-1",
      roles: {
        cache: collection([
          role("osu", "osu!"),
          role("osu-ingame", "osu!-ingame"),
          role("lol-ingame", "League of Legends-ingame"),
          role("mc", "Minecraft", 8n),
        ]),
      },
      channels: { cache: collection([botChannel]) },
      members: { me: { id: "bot" } },
    };
  });

  it("links roles named after a new game and hands both out", async () => {
    const member = createMember();

    await update(member, [playing(osu)]);

    expect(member.roles.add).toHaveBeenCalledWith(guild.roles.cache.get("osu"));
    expect(member.roles.add).toHaveBeenCalledWith(
      guild.roles.cache.get("osu-ingame"),
    );
    const state = await store.getGuildState("guild-1");
    expect(state.games.get("app-osu")).toMatchObject({
      status: "linked",
      roleId: "osu",
      ingameRoleId: "osu-ingame",
    });
  });

  it("links the channel the game's role opens, once the bot can see it", async () => {
    const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
    const view = (bits) => new PermissionsBitField(bits);
    guild.channels.cache.set("osu-channel", {
      id: "osu-channel",
      name: "osu",
      type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: collection([
          {
            id: "guild-1",
            allow: view(0n),
            deny: view(PermissionFlagsBits.ViewChannel),
          },
          {
            id: "osu",
            allow: view(PermissionFlagsBits.ViewChannel),
            deny: view(0n),
          },
        ]),
      },
    });

    await update(createMember(), [playing(osu)]);

    const state = await store.getGuildState("guild-1");
    expect(state.games.get("app-osu").channelId).toBe("osu-channel");
  });

  it("keeps working after a linked role is renamed", async () => {
    const state = await store.getGuildState("guild-1");
    store.setGame("guild-1", state, "app-osu", {
      status: "linked",
      name: "osu!",
      roleId: "osu",
      ingameRoleId: "osu-ingame",
    });
    guild.roles.cache.get("osu").name = "Osu (rhythm)";
    const member = createMember();

    await update(member, [playing(osu)]);

    expect(member.roles.add).toHaveBeenCalledWith(guild.roles.cache.get("osu"));
  });

  it("takes the in-game role off when the game stops, keeping the game role", async () => {
    await update(createMember(), [playing(osu)]);
    const member = createMember("member-1", [
      guild.roles.cache.get("osu"),
      guild.roles.cache.get("osu-ingame"),
    ]);

    await update(member, []);

    expect(member.roles.remove).toHaveBeenCalledWith(
      guild.roles.cache.get("osu-ingame"),
    );
    expect(member.roles.remove).not.toHaveBeenCalledWith(
      guild.roles.cache.get("osu"),
    );
  });

  it("removes leftover -ingame roles from before the game list", async () => {
    const member = createMember("member-1", [
      guild.roles.cache.get("lol-ingame"),
    ]);

    await update(member, []);

    expect(member.roles.remove).toHaveBeenCalledWith(
      guild.roles.cache.get("lol-ingame"),
    );
  });

  it("doesn't give a game role back to someone who opted out of it", async () => {
    const state = await store.getGuildState("guild-1");
    store.setOptOut("guild-1", state, "member-1", "osu", true);
    const member = createMember();

    await update(member, [playing(osu)]);

    expect(member.roles.add).not.toHaveBeenCalledWith(
      guild.roles.cache.get("osu"),
    );
    expect(member.roles.add).toHaveBeenCalledWith(
      guild.roles.cache.get("osu-ingame"),
    );
  });

  it("proposes an unknown game once two members played it", async () => {
    const state = await store.getGuildState("guild-1");
    store.setConfig("guild-1", state, { botChannelId: "bot-channel" });
    const palworld = playing({ applicationId: "app-pal", name: "Palworld" });

    await update(createMember("member-1"), [palworld]);
    await update(createMember("member-1"), [palworld]);
    expect(botChannel.send).not.toHaveBeenCalled();

    await update(createMember("member-2"), [palworld]);
    expect(botChannel.send).toHaveBeenCalledTimes(1);
    expect(botChannel.send.mock.calls[0][0].content).toContain("Palworld");
    expect(state.games.get("app-pal")).toMatchObject({ status: "proposed" });
    expect(state.players.has("app-pal")).toBe(false);

    await update(createMember("member-3"), [palworld]);
    expect(botChannel.send).toHaveBeenCalledTimes(1);
  });

  it("keeps no play history while the server has no bot channel", async () => {
    const state = await store.getGuildState("guild-1");

    await update(createMember(), [
      playing({ applicationId: "app-pal", name: "Palworld" }),
    ]);

    expect(state.players.size).toBe(0);
  });

  it("only counts games being played, not other apps", async () => {
    const state = await store.getGuildState("guild-1");
    store.setConfig("guild-1", state, { botChannelId: "bot-channel" });
    const music = {
      type: ActivityType.Listening,
      applicationId: "app-music",
      name: "Some Music App",
    };

    await update(createMember(), [music]);

    expect(state.players.has("app-music")).toBe(false);
  });

  it("never hands out a role that grants permissions", async () => {
    const member = createMember();

    await update(member, [
      playing({ applicationId: "app-mc", name: "Minecraft" }),
    ]);

    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("ignores bots", async () => {
    const member = createMember();
    member.user.bot = true;

    await update(member, [playing(osu)]);

    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("does nothing while the stored state can't be read", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    global.fetch = jest.fn(() => Promise.reject(new Error("down")));
    const member = createMember();

    await update(member, [playing(osu)]);

    expect(member.roles.add).not.toHaveBeenCalled();
    delete global.fetch;
  });
});
