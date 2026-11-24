const { Collection } = require("discord.js");

describe("deploy notice", () => {
  let announceDeploy;
  let store;
  let state;
  let channel;
  let client;

  beforeEach(async () => {
    jest.resetModules();
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    process.env.GIT_SHA = "bbbbbbbbbbbb";
    process.env.RELEASE_VERSION = "gh-7";
    jest.doMock("../src/utils/upstash", () => ({
      isEnabled: () =>
        Boolean(
          process.env.UPSTASH_REDIS_REST_URL &&
            process.env.UPSTASH_REDIS_REST_TOKEN,
        ),
      runCommand: jest.fn(() => Promise.resolve([])),
    }));
    store = require("../src/games/store");
    ({ announceDeploy } = require("../src/deployNotice"));

    channel = { id: "bot-channel", send: jest.fn(() => Promise.resolve()) };
    const guild = {
      id: "guild-1",
      channels: { cache: new Collection([[channel.id, channel]]) },
    };
    client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
    state = await store.getGuildState("guild-1");
    store.setConfig("guild-1", state, {
      botChannelId: "bot-channel",
      announcedSha: "aaaaaaaaaaaa",
    });
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.GIT_SHA;
    delete process.env.RELEASE_VERSION;
  });

  it("announces a new commit once, with what changed since the last one", async () => {
    await announceDeploy(client);
    await announceDeploy(client); // a restart on the same commit

    expect(channel.send).toHaveBeenCalledTimes(1);
    const { content } = channel.send.mock.calls[0][0];
    expect(content).toContain("`bbbbbbb` (gh-7)");
    expect(content).toContain("/compare/aaaaaaaaaaaa...bbbbbbbbbbbb");
    expect(state.config.announcedSha).toBe("bbbbbbbbbbbb");
  });

  it("stays quiet without a bot channel, a commit, or somewhere to remember it", async () => {
    store.setConfig("guild-1", state, { botChannelId: undefined });
    await announceDeploy(client);
    store.setConfig("guild-1", state, { botChannelId: "bot-channel" });
    delete process.env.GIT_SHA;
    await announceDeploy(client);
    process.env.GIT_SHA = "bbbbbbbbbbbb";
    delete process.env.UPSTASH_REDIS_REST_URL;
    await announceDeploy(client);

    expect(channel.send).not.toHaveBeenCalled();
    expect(state.config.announcedSha).toBe("aaaaaaaaaaaa");
  });
});
