const { MessageFlags } = require("discord.js");
const {
  buildQueueMessage,
  buildVersionMessage,
  createMessageCreateHandler,
} = require("../src/handlers/messageCreate");

describe("Message Create Handler", () => {
  const queueTrack = {
    title: "Test Song",
    url: "https://www.youtube.com/watch?v=testsong123",
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
      channel: { send, sendTyping: jest.fn(() => Promise.resolve()) },
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

    expect(msg.channel.send).toHaveBeenCalledWith({
      content: "pong",
      flags: MessageFlags.SuppressNotifications,
    });
  });

  it("queues a track from the caller's voice channel", async () => {
    const musicPlayer = {
      enqueue: jest.fn(() =>
        Promise.resolve({
          started: true,
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
      expect.objectContaining({
        content:
          "Queued **[Test Song](<https://www.youtube.com/watch?v=testsong123>)** (3:10).",
      }),
    );
  });

  it("shows typing on !play before the track has resolved", async () => {
    const musicPlayer = {
      enqueue: jest.fn(() => new Promise(() => {})), // yt-dlp still working
      getQueue: jest.fn(() => null),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!play something slow" });

    handler(msg);
    await new Promise((resolve) => setImmediate(resolve));

    expect(msg.channel.sendTyping).toHaveBeenCalled();
    expect(msg.channel.send).not.toHaveBeenCalled();
  });

  it("still plays when typing is not permitted", async () => {
    const musicPlayer = {
      enqueue: jest.fn(() =>
        Promise.resolve({
          started: true,
          tracks: [queueTrack],
          tracksAdded: 1,
        }),
      ),
      getQueue: jest.fn(() => null),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!play test" });
    msg.channel.sendTyping.mockRejectedValue(new Error("Missing Permissions"));

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Queued **[Test Song](<https://www.youtube.com/watch?v=testsong123>)** (3:10).",
      }),
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
      expect.objectContaining({ content: "Join a voice channel first." }),
    );
  });

  it("maps aborted playback errors to a retry message", async () => {
    const musicPlayer = {
      enqueue: jest.fn(() =>
        Promise.reject(new Error("The operation was aborted")),
      ),
      getQueue: jest.fn(() => null),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!play test" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Playback request was interrupted. Please try !play again.",
      }),
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

    expect(musicPlayer.skip).toHaveBeenCalledWith("guild-1", "tester");
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Skipped **[Test Song](<https://www.youtube.com/watch?v=testsong123>)**.",
      }),
    );
  });

  it("shows current volume", async () => {
    const musicPlayer = {
      getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
      getVolume: jest.fn(() => 75),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!volume" });

    await handler(msg);

    expect(musicPlayer.getVolume).toHaveBeenCalledWith("guild-1");
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Current volume: **75%**." }),
    );
  });

  it("sets volume", async () => {
    const musicPlayer = {
      getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
      setVolume: jest.fn(() => 120),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!volume 120" });

    await handler(msg);

    expect(musicPlayer.setVolume).toHaveBeenCalledWith("guild-1", 1.2);
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Volume set to **120%**." }),
    );
  });

  it("shows volume usage for invalid values", async () => {
    const musicPlayer = {
      getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!volume loud" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Usage: !volume <0-200>" }),
    );
  });

  it("renders the queue summary", () => {
    const message = buildQueueMessage({
      currentTrack: queueTrack,
      tracks: [{ title: "Next Song", durationLabel: "4:20" }],
    });

    expect(message).toContain("Now playing");
    expect(message).toContain("Next Song");
  });

  it("links queued titles, escaping brackets in them", () => {
    const message = buildQueueMessage({
      currentTrack: null,
      tracks: [
        {
          title: "a-ha - Take On Me [4K]",
          url: "https://youtu.be/x",
          durationLabel: "3:45",
        },
      ],
    });

    expect(message).toBe(
      "1. **[a-ha - Take On Me \\[4K\\]](<https://youtu.be/x>)** (3:45)",
    );
  });

  it("drops the links when they'd push the queue past Discord's 2000 characters", () => {
    const track = {
      title: "t".repeat(100),
      url: `https://soundcloud.com/${"a".repeat(60)}`, // 11 YouTube links still fit
      durationLabel: "10:00",
    };
    const message = buildQueueMessage({
      currentTrack: track,
      tracks: Array(12).fill(track),
    });

    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).not.toContain("](<");
  });

  it("toggles autoplay", async () => {
    const musicPlayer = {
      getQueue: jest.fn(() => ({ voiceChannelId: "voice-1" })),
      toggleAutoplay: jest.fn(() => true),
    };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!autoplay" });

    await handler(msg);

    expect(musicPlayer.toggleAutoplay).toHaveBeenCalledWith("guild-1");
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/^🔁 Autoplay on/),
      }),
    );
  });

  it("returns the bot version", async () => {
    const musicPlayer = { getQueue: jest.fn() };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!version" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: buildVersionMessage() }),
    );
  });

  it("includes build fingerprint in version output", () => {
    const message = buildVersionMessage();

    expect(message).toContain("Version:");
    expect(message).toContain("Build:");
  });

  it("lists commands in !commands output", async () => {
    const musicPlayer = { getQueue: jest.fn() };
    const handler = createMessageCreateHandler({ musicPlayer });
    const msg = createMessage({ content: "!commands" });

    await handler(msg);

    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("!play") }),
    );
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("!volume <0-200>"),
      }),
    );
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("!version") }),
    );
  });

  describe("server setup", () => {
    const { Collection } = require("discord.js");
    const store = require("../src/games/store");

    const setupMessage = (content, { canManageRoles = true } = {}) => {
      const msg = createMessage({ content });
      const dj = {
        id: "dj",
        name: "DJ",
        editable: true,
        managed: false,
        permissions: { bitfield: 0n },
      };
      const mod = {
        ...dj,
        id: "mod",
        name: "Mod",
        permissions: { bitfield: 8n },
      };
      msg.guild = {
        id: "setup-guild",
        ownerId: "owner",
        roles: {
          cache: new Collection([
            ["dj", dj],
            ["mod", mod],
          ]),
        },
      };
      dj.guild = msg.guild;
      mod.guild = msg.guild;
      msg.author.id = "owner";
      msg.channel.id = "bot-channel";
      msg.member.permissions = { has: () => canManageRoles };
      return msg;
    };
    const run = (msg) =>
      createMessageCreateHandler({ musicPlayer: { getQueue: jest.fn() } })(msg);

    it("refuses setup commands without Manage Roles", async () => {
      const msg = setupMessage("!botchannel", { canManageRoles: false });

      await run(msg);

      expect(msg.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "You need the Manage Roles permission for that.",
        }),
      );
      const state = await store.getGuildState("setup-guild");
      expect(state.config.botChannelId).toBeUndefined();
    });

    it("sets the bot channel and toggles picker extras, never roles with permissions", async () => {
      await run(setupMessage("!botchannel"));
      await run(setupMessage("!pickable dj"));
      await run(setupMessage("!pickable Mod"));
      const state = await store.getGuildState("setup-guild");
      expect(state.config).toEqual({
        botChannelId: "bot-channel",
        extraRoleIds: ["dj"],
      });

      await run(setupMessage("!pickable DJ"));
      expect(state.config.extraRoleIds).toEqual([]);
    });

    it("sets the music channel named from another channel, silently", async () => {
      const msg = setupMessage("!musicchannel #music");
      msg.guild.id = "music-setup-guild";
      const music = {
        id: "music-channel",
        guild: msg.guild,
        toString: () => "<#music-channel>",
      };
      msg.mentions = { channels: new Collection([["music-channel", music]]) };

      await run(msg);

      const state = await store.getGuildState("music-setup-guild");
      expect(state.config.musicChannelId).toBe("music-channel");
      expect(msg.channel.send.mock.calls[0][0]).toMatchObject({
        content: expect.stringContaining("<#music-channel>"),
        flags: MessageFlags.SuppressNotifications,
      });
    });
  });

  describe("music channel", () => {
    const {
      Collection,
      PermissionFlagsBits,
      PermissionsBitField,
    } = require("discord.js");
    const store = require("../src/games/store");

    const createPlayer = () => ({
      getQueue: jest.fn(() => null),
      enqueue: jest.fn(() =>
        Promise.resolve({
          started: true,
          tracks: [queueTrack],
          tracksAdded: 1,
        }),
      ),
    });

    const playIn = async (guildId, channelId) => {
      const dj = {
        id: "dj",
        name: "DJ",
        editable: true,
        managed: false,
        permissions: { bitfield: 0n },
      };
      const musicChannel = {
        id: "music",
        toString: () => "<#music>",
        permissionOverwrites: {
          cache: new Collection([
            [
              "dj",
              {
                id: "dj",
                allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
              },
            ],
          ]),
        },
      };
      const msg = createMessage({ content: "!play some song" });
      msg.guild = {
        id: guildId,
        channels: { cache: new Collection([["music", musicChannel]]) },
        roles: { cache: new Collection([["dj", dj]]) },
      };
      dj.guild = msg.guild;
      msg.channel.id = channelId;
      msg.channel.send = jest.fn(() =>
        Promise.resolve({ delete: jest.fn(() => Promise.resolve()) }),
      );
      msg.author.id = "user-1";
      msg.author.toString = () => "<@user-1>";
      msg.member.roles = {
        cache: new Collection(),
        add: jest.fn(() => Promise.resolve()),
      };
      msg.delete = jest.fn(() => Promise.resolve());
      const state = await store.getGuildState(guildId);
      store.setConfig(guildId, state, { musicChannelId: "music" });
      return msg;
    };

    afterEach(() => jest.useRealTimers());

    it("sends music commands elsewhere to the music channel, giving the role that opens it", async () => {
      jest.useFakeTimers();
      const msg = await playIn("music-guild", "general");
      const musicPlayer = createPlayer();

      await createMessageCreateHandler({ musicPlayer })(msg);

      expect(musicPlayer.enqueue).not.toHaveBeenCalled();
      expect(msg.delete).toHaveBeenCalled();
      expect(msg.member.roles.add).toHaveBeenCalledWith(
        expect.objectContaining({ id: "dj" }),
        expect.anything(),
      );
      expect(msg.channel.send.mock.calls[0][0].content).toBe(
        "<@user-1>, music commands go in <#music>. I gave you **DJ** so you can see it.",
      );
      const reply = await msg.channel.send.mock.results[0].value;
      jest.advanceTimersByTime(10_000);
      expect(reply.delete).toHaveBeenCalled();
    });

    it("plays normally in the music channel", async () => {
      const msg = await playIn("music-guild", "music");
      const musicPlayer = createPlayer();

      await createMessageCreateHandler({ musicPlayer })(msg);

      expect(musicPlayer.enqueue).toHaveBeenCalled();
      expect(msg.delete).not.toHaveBeenCalled();
    });

    it("plays anyway when the setting can't be read", async () => {
      process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
      process.env.UPSTASH_REDIS_REST_TOKEN = "token";
      global.fetch = jest.fn(() => Promise.reject(new Error("down")));
      const msg = createMessage({ content: "!play some song" });
      msg.guild = { id: "redis-down-guild" };
      const musicPlayer = createPlayer();

      try {
        await createMessageCreateHandler({ musicPlayer })(msg);
      } finally {
        delete process.env.UPSTASH_REDIS_REST_URL;
        delete process.env.UPSTASH_REDIS_REST_TOKEN;
        delete global.fetch;
      }

      expect(musicPlayer.enqueue).toHaveBeenCalled();
    });
  });
});
