const { ChannelType, Collection, PermissionFlagsBits } = require("discord.js");

const collection = (items) => new Collection(items.map((i) => [i.id, i]));

describe("games", () => {
  let store;
  let picker;
  let proposals;
  let guild;
  let state;
  let proposalMessage;

  const role = (id, name, extra = {}) => ({
    id,
    name,
    guild,
    editable: true,
    managed: false,
    permissions: { bitfield: 0n },
    position: 1,
    ...extra,
  });

  const createMember = (roleIds = []) => {
    const member = {
      id: "member-1",
      roles: {
        cache: collection(roleIds.map((id) => guild.roles.cache.get(id))),
        add: jest.fn((id) =>
          Promise.resolve(
            member.roles.cache.set(id, guild.roles.cache.get(id)),
          ),
        ),
        remove: jest.fn((id) => Promise.resolve(member.roles.cache.delete(id))),
      },
    };
    return member;
  };

  const interaction = (customId, extra = {}) => ({
    customId,
    guild,
    user: { id: "owner", toString: () => "<@owner>" },
    memberPermissions: { has: () => true },
    member: createMember(),
    deferUpdate: jest.fn(() => Promise.resolve()),
    editReply: jest.fn(() => Promise.resolve()),
    followUp: jest.fn(() => Promise.resolve()),
    reply: jest.fn(() => Promise.resolve()),
    update: jest.fn(() => Promise.resolve()),
    isStringSelectMenu: () => false,
    ...extra,
  });

  beforeEach(async () => {
    jest.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    store = require("../src/games/store");
    picker = require("../src/games/picker");
    proposals = require("../src/games/proposals");

    proposalMessage = { edit: jest.fn(() => Promise.resolve()) };
    let nextId = 0;
    guild = { id: "guild-1", ownerId: "owner" };
    guild.roles = {
      everyone: { id: "guild-1" },
      cache: new Collection(),
      create: jest.fn((options) => {
        const created = role(`new-${++nextId}`, options.name, {
          setPosition: jest.fn(() => Promise.resolve()),
        });
        guild.roles.cache.set(created.id, created);
        return Promise.resolve(created);
      }),
    };
    for (const r of [
      role("osu", "osu!"),
      role("osu-ingame", "osu!-ingame"),
      role("valorant", "VALORANT"),
      role("dj", "DJ"),
      role("mod", "Mod", { permissions: { bitfield: 8n } }),
      // A hand-made pair nobody has played since the bot started tracking.
      role("valheim", "Valheim"),
      role("valheim-ingame", "Valheim-ingame"),
      role("mod-ingame", "Mod-ingame"),
    ]) {
      guild.roles.cache.set(r.id, r);
    }
    guild.channels = {
      cache: collection([
        {
          id: "bot-channel",
          messages: {
            edit: jest.fn((id, payload) => proposalMessage.edit(payload)),
          },
        },
      ]),
      create: jest.fn(() => Promise.resolve({ id: "new-channel" })),
    };
    guild.members = { me: { id: "bot" } };
    guild.presences = { cache: new Collection() };

    state = await store.getGuildState("guild-1");
    store.setGame("guild-1", state, "app-osu", {
      status: "linked",
      name: "osu!",
      roleId: "osu",
      ingameRoleId: "osu-ingame",
    });
    store.setGame("guild-1", state, "app-val", {
      status: "linked",
      name: "VALORANT",
      roleId: "valorant",
    });
    store.setConfig("guild-1", state, { extraRoleIds: ["dj", "mod"] });
  });

  describe("role picker", () => {
    it("lists game roles, hand-made pairs and extras, ticked as the member has them, never roles with permissions", async () => {
      const press = interaction("roles:open", { member: createMember(["dj"]) });

      await picker.handleRolesInteraction(press);

      const [list] = press.reply.mock.calls[0][0].components;
      const options = list.components[0].toJSON().options;
      expect(options.map((o) => [o.label, Boolean(o.default)])).toEqual([
        ["DJ", true],
        ["osu!", false],
        ["Valheim", false],
        ["VALORANT", false],
      ]);
    });

    it("changes only the roles in the submitted list and remembers opt-outs", async () => {
      const member = createMember(["osu", "dj"]);
      const submit = interaction("roles:pick:0", {
        member,
        isStringSelectMenu: () => true,
        // This list showed osu! and VALORANT (plus a role no longer pickable);
        // DJ sits in another list.
        component: {
          options: [{ value: "osu" }, { value: "valorant" }, { value: "mod" }],
        },
        values: ["valorant", "mod"],
      });

      await picker.handleRolesInteraction(submit);

      expect(member.roles.add.mock.calls.map(([id]) => id)).toEqual([
        "valorant",
      ]);
      expect(member.roles.remove.mock.calls.map(([id]) => id)).toEqual(["osu"]);
      expect(store.isOptedOut(state, "member-1", "osu")).toBe(true);
      expect(submit.editReply).toHaveBeenCalled();
    });
  });

  describe("role picker channel", () => {
    const { PermissionsBitField } = require("discord.js");
    const fakeChannel = (events, overwrites = []) => ({
      id: "roles",
      permissionOverwrites: {
        cache: collection(overwrites),
        edit: jest.fn((target, permissions) => {
          events.push(["edit", target.id, permissions]);
          return Promise.resolve();
        }),
      },
      messages: {
        delete: jest.fn((id) => {
          events.push(["delete", id]);
          return Promise.resolve();
        }),
      },
      send: jest.fn((payload) => {
        events.push(["send", payload.content.split("\n")[0]]);
        return Promise.resolve({ id: "picker-message" });
      }),
    });

    it("makes #roles hidden, posts the picker, and only then shows it", async () => {
      const events = [];
      const channel = fakeChannel(events);
      guild.channels.create = jest.fn((options) => {
        events.push(["create", options.permissionOverwrites[0]]);
        return Promise.resolve(channel);
      });

      await picker.setUpPicker(guild, state);

      expect(events[0]).toEqual([
        "create",
        {
          id: "guild-1",
          deny: expect.arrayContaining([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ]),
        },
      ]);
      expect(events.slice(-2)).toEqual([
        ["send", "**Pick your games**"],
        ["edit", "guild-1", { ViewChannel: null }],
      ]);
      expect(state.config.picker).toEqual({
        channelId: "roles",
        messageId: "picker-message",
      });
    });

    it("hides the existing channel while it swaps the picker", async () => {
      const events = [];
      guild.channels.cache.set("roles", fakeChannel(events));
      store.setConfig("guild-1", state, {
        picker: { channelId: "roles", messageId: "old-picker" },
      });

      await picker.setUpPicker(guild, state);

      expect(guild.channels.create).not.toHaveBeenCalled();
      expect(events).toEqual([
        [
          "edit",
          "guild-1",
          {
            ViewChannel: false,
            SendMessages: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          },
        ],
        ["delete", "old-picker"],
        ["edit", "bot", { ViewChannel: true, SendMessages: true }],
        ["send", "**Pick your games**"],
        ["edit", "guild-1", { ViewChannel: null }],
      ]);
    });

    it("leaves a channel kept private hidden", async () => {
      const events = [];
      guild.channels.cache.set(
        "roles",
        fakeChannel(events, [
          {
            id: "guild-1",
            deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
          },
        ]),
      );
      store.setConfig("guild-1", state, {
        picker: { channelId: "roles", messageId: "old-picker" },
      });

      await picker.setUpPicker(guild, state);

      expect(events.at(-1)).toEqual([
        "edit",
        "guild-1",
        { ViewChannel: false },
      ]);
    });
  });

  describe("adopting hand-made game channels", () => {
    const { PermissionsBitField } = require("discord.js");
    const VIEW = PermissionFlagsBits.ViewChannel;
    const overwrite = (id, allow, deny) => ({
      id,
      allow: new PermissionsBitField(allow),
      deny: new PermissionsBitField(deny),
    });
    const hiddenChannel = (id, name, openerId) => ({
      id,
      name,
      type: ChannelType.GuildText,
      toString: () => `<#${id}>`,
      permissionOverwrites: {
        cache: collection([
          overwrite("guild-1", 0n, VIEW),
          overwrite(openerId, VIEW, 0n),
        ]),
        edit: jest.fn(() => Promise.resolve()),
      },
    });

    beforeEach(() => {
      guild.roles.cache.set("among", role("among", "Among Us"));
      guild.channels.cache.set(
        "among-us",
        hiddenChannel("among-us", "among-us", "among"),
      );
      guild.channels.cache.set("music", hiddenChannel("music", "music", "dj"));
      guild.channels.cache.set(
        "staff",
        hiddenChannel("staff", "mod", "mod"), // its role has permissions
      );
      guild.channels.fetch = jest.fn(() =>
        Promise.resolve(guild.channels.cache),
      );
      guild.members.me = { id: "bot", permissions: { has: () => false } };
    });

    it("adds the bot to channels named after the no-permission role that opens them", async () => {
      store.setGame("guild-1", state, "app-among", {
        status: "linked",
        name: "Among Us",
        roleId: "among",
      });

      const result = await proposals.adoptChannels(guild, state);

      expect(result.adopted.map(({ channel }) => channel.id)).toEqual([
        "among-us",
      ]);
      expect(
        guild.channels.cache.get("among-us").permissionOverwrites.edit,
      ).toHaveBeenCalledWith(
        guild.members.me,
        { ViewChannel: true },
        expect.anything(),
      );
      expect(result.skipped.map(({ channel }) => channel.id)).toEqual([
        "music",
      ]);
      expect(
        guild.channels.cache.get("staff").permissionOverwrites.edit,
      ).not.toHaveBeenCalled();
      expect(state.games.get("app-among").channelId).toBe("among-us");
      expect(result.sawEverything).toBe(false);
    });

    it("puts roles that open a game channel in the picker, but not other private channels' roles", () => {
      const names = picker
        .pickableRoles(guild, state)
        .map((pickable) => pickable.name);

      expect(names).toContain("Among Us");
      expect(names).not.toContain("Mod");
    });
  });

  describe("proposals", () => {
    beforeEach(() => {
      store.setGame("guild-1", state, "app-pal", {
        status: "proposed",
        name: "Palworld",
        proposal: { channelId: "bot-channel", messageId: "proposal-1" },
      });
    });

    it("refuses members without Manage Roles", async () => {
      const press = interaction("game:create:app-pal", {
        memberPermissions: { has: () => false },
      });

      await proposals.handleGameInteraction(press);

      expect(guild.roles.create).not.toHaveBeenCalled();
      expect(press.reply).toHaveBeenCalled();
    });

    it("creates both roles and a channel only the game role and the bot can see", async () => {
      const press = interaction("game:create:app-pal");

      await proposals.handleGameInteraction(press);

      expect(guild.roles.create.mock.calls.map(([o]) => o.name)).toEqual([
        "Palworld",
        "Palworld-ingame",
      ]);
      expect(guild.roles.create.mock.calls[1][0]).toMatchObject({
        hoist: true,
        permissions: [],
      });
      // Placed next to the existing in-game role.
      expect(guild.roles.cache.get("new-2").setPosition).toHaveBeenCalledWith(
        1,
        expect.anything(),
      );
      const channel = guild.channels.create.mock.calls[0][0];
      expect(channel.type).toBe(ChannelType.GuildText);
      expect(channel.permissionOverwrites).toEqual([
        { id: "guild-1", deny: [PermissionFlagsBits.ViewChannel] },
        { id: "new-1", allow: [PermissionFlagsBits.ViewChannel] },
        { id: "bot", allow: [PermissionFlagsBits.ViewChannel] },
      ]);
      expect(state.games.get("app-pal")).toMatchObject({
        status: "linked",
        roleId: "new-1",
        ingameRoleId: "new-2",
        channelId: "new-channel",
      });
      expect(press.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });

    it("puts a new channel where the bot's newest channel went, ignoring linked ones", async () => {
      const channel = (id, parentId) =>
        guild.channels.cache.set(id, {
          id,
          parentId,
          createdTimestamp: Number(id),
        });
      channel("100", "dead-games"); // made first, archived since
      channel("200", "games"); // made most recently
      channel("300", "dead-games"); // newest, but linked, not made
      const game = (appId, channelId, madeChannel) =>
        store.setGame("guild-1", state, appId, {
          status: "linked",
          name: appId,
          channelId,
          madeChannel,
        });
      game("app-old", "100", true);
      game("app-new", "200", true);
      game("app-linked", "300", false);

      await proposals.handleGameInteraction(interaction("game:create:app-pal"));

      expect(guild.channels.create.mock.calls[0][0].parent).toBe("games");
      expect(state.games.get("app-pal").madeChannel).toBe(true);
    });

    it("only takes the buttons off a proposal that was already answered", async () => {
      store.setGame("guild-1", state, "app-pal", {
        ...state.games.get("app-pal"),
        status: "ignored",
      });
      const press = interaction("game:create:app-pal");

      await proposals.handleGameInteraction(press);

      expect(guild.roles.create).not.toHaveBeenCalled();
      expect(press.update).toHaveBeenCalledWith({ components: [] });
    });

    it("ignores a game for good", async () => {
      const press = interaction("game:ignore:app-pal");

      await proposals.handleGameInteraction(press);

      expect(state.games.get("app-pal").status).toBe("ignored");
      expect(press.update).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });

    it("links an existing role and closes the proposal, but never a role with permissions", async () => {
      const refused = interaction("game:linkrole:app-pal", { values: ["mod"] });
      await proposals.handleGameInteraction(refused);
      expect(state.games.get("app-pal").status).toBe("proposed");

      const linked = interaction("game:linkrole:app-pal", {
        values: ["valorant"],
      });
      await proposals.handleGameInteraction(linked);
      expect(state.games.get("app-pal")).toMatchObject({
        status: "linked",
        roleId: "valorant",
      });
      expect(proposalMessage.edit).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });
  });

  it("game check lists games missing a role or channel", () => {
    const [message] = proposals.gameCheck(guild, state);

    expect(message.content).toContain("**osu!**: no channel");
    expect(message.content).toContain(
      "**VALORANT**: no in-game role, no channel",
    );
    expect(
      message.components[0].components.map((b) => b.toJSON().custom_id),
    ).toEqual(["game:link:app-osu", "game:link:app-val"]);
  });
});
