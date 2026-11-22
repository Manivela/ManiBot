// Games nobody has set up yet: once enough members play one, the bot asks in
// the guild's bot channel (`!botchannel`) and waits. Someone with Manage Roles
// creates its roles (and channel), links existing ones, or ignores it.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  escapeMarkdown,
} = require("discord.js");
const Sentry = require("@sentry/node");
const debug = require("debug")("games:proposals");
const store = require("./store");
const { canHandOut, channelGameRole } = require("./picker");

// Different members within the store's 30-day window. One in development,
// where the dev server has a single member.
const PROPOSAL_THRESHOLD = process.env.NODE_ENV === "development" ? 1 : 2;

// Discord's preset role colours, for new in-game roles.
const COLORS = [
  0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22,
  0xe74c3c, 0x11806a, 0x1f8b4c, 0x206694, 0x71368a, 0xad1457, 0xc27c0e,
  0xa84300, 0x992d22,
];

// Messages name roles; mentioning one must not ping everyone who has it.
const NO_PINGS = { parse: [] };

const busy = new Set();

const button = (customId, label, style) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);

const summary = (game) =>
  [
    game.roleId && `<@&${game.roleId}>`,
    game.ingameRoleId && `<@&${game.ingameRoleId}>`,
    game.channelId && `<#${game.channelId}>`,
  ]
    .filter(Boolean)
    .join(" · ") || "nothing yet";

// Called for every "Playing" activity of a game with no record yet.
const notePlayer = async (guild, state, activity, member) => {
  const appId = activity.applicationId;
  const key = `${guild.id}:${appId}`;
  const channel = guild.channels.cache.get(state.config.botChannelId);
  // Without a bot channel nothing can be proposed, so don't keep who played.
  if (state.games.has(appId) || !channel) {
    return;
  }
  const count = store.addPlayer(guild.id, state, appId, member.id);
  if (
    count < PROPOSAL_THRESHOLD ||
    busy.has(key) ||
    !channel
      .permissionsFor(guild.members.me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
  ) {
    return;
  }

  busy.add(key);
  try {
    const message = await channel.send({
      content: `🎮 **${escapeMarkdown(activity.name)}**: ${count} member${count === 1 ? "" : "s"} played it in the last 30 days. Set it up as a game?`,
      components: [
        new ActionRowBuilder().addComponents(
          button(
            `game:create:${appId}`,
            "Create roles + channel",
            ButtonStyle.Success,
          ),
          button(`game:roles:${appId}`, "Roles only", ButtonStyle.Primary),
          button(
            `game:link:${appId}`,
            "Link to existing…",
            ButtonStyle.Secondary,
          ),
          button(`game:ignore:${appId}`, "Ignore", ButtonStyle.Danger),
        ),
      ],
      allowedMentions: NO_PINGS,
    });
    store.setGame(guild.id, state, appId, {
      status: "proposed",
      name: activity.name,
      proposal: { channelId: channel.id, messageId: message.id },
    });
  } catch (error) {
    debug("failed to propose %s", activity.name, error);
    Sentry.captureException(error);
  } finally {
    busy.delete(key);
  }
};

// The category of the channel the bot made most recently (wherever it's been
// moved): the newest game is the likeliest to still be played, while older
// ones end up in an archive. Linked channels don't count.
const gameCategory = (guild, linked) =>
  linked
    .filter((game) => game.madeChannel)
    .map((game) => guild.channels.cache.get(game.channelId))
    .filter(Boolean)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0]?.parentId ??
  null;

const createGame = async (guild, state, appId, game, withChannel) => {
  const reason = `Game roles for ${game.name}`;
  const linked = [...state.games.values()].filter(
    (other) => other.status === "linked",
  );
  const ingameRoles = linked
    .map((other) => guild.roles.cache.get(other.ingameRoleId))
    .filter((role) => role?.editable);
  const usedColors = new Set(
    ingameRoles.map((role) => role.colors?.primaryColor ?? role.color),
  );
  const highestIngame = ingameRoles.reduce(
    (top, role) => (!top || role.position > top.position ? role : top),
    null,
  );

  const next = { status: "linked", name: game.name, proposal: game.proposal };
  try {
    next.roleId = (
      await guild.roles.create({
        name: game.name,
        permissions: [],
        mentionable: true,
        reason,
      })
    ).id;
    const ingameRole = await guild.roles.create({
      name: `${game.name}-ingame`,
      permissions: [],
      hoist: true,
      mentionable: true,
      colors: {
        primaryColor:
          COLORS.find((color) => !usedColors.has(color)) ??
          COLORS[usedColors.size % COLORS.length],
      },
      reason,
    });
    next.ingameRoleId = ingameRole.id;
    // Among the other in-game roles, so its colour shows over lower roles. A
    // failed move only costs the placement.
    if (highestIngame) {
      await ingameRole
        .setPosition(highestIngame.position, { reason })
        .catch(debug);
    }
    if (withChannel) {
      next.channelId = (
        await guild.channels.create({
          name: game.name,
          type: ChannelType.GuildText,
          parent: gameCategory(guild, linked),
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            { id: next.roleId, allow: [PermissionFlagsBits.ViewChannel] },
            // The bot keeps seeing it, to find its category for the next one.
            {
              id: guild.members.me.id,
              allow: [PermissionFlagsBits.ViewChannel],
            },
          ],
          reason,
        })
      ).id;
      next.madeChannel = true;
    }
  } finally {
    // Keep whatever got made even if a later step failed.
    if (next.roleId) {
      store.setGame(guild.id, state, appId, next);
    }
  }

  // Whoever is playing it right now gets the roles; the rest the next time.
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member;
    if (
      member &&
      !member.user.bot &&
      presence.activities.some((activity) => activity.applicationId === appId)
    ) {
      await member.roles.add(next.roleId, reason).catch(debug);
      await member.roles.add(next.ingameRoleId, reason).catch(debug);
    }
  }
  return next;
};

const linkMenus = (appId) => [
  new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`game:linkrole:${appId}`)
      .setPlaceholder("Game role (opens its channel)"),
  ),
  new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`game:linkingame:${appId}`)
      .setPlaceholder("In-game role (groups players)"),
  ),
  new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`game:linkchannel:${appId}`)
      .setPlaceholder("Game channel")
      .setChannelTypes(ChannelType.GuildText),
  ),
];

// `!gamecheck`: set-up games missing a role or channel (a role named a bit
// differently from the game, a game with one role only), each with a button
// to link what's missing.
const gameCheck = (guild, state) => {
  const issues = [];
  for (const [appId, game] of state.games) {
    if (game.status !== "linked") {
      continue;
    }
    const missing = [
      !guild.roles.cache.has(game.roleId) && "game role",
      !guild.roles.cache.has(game.ingameRoleId) && "in-game role",
      !game.channelId && "channel",
    ].filter(Boolean);
    if (missing.length) {
      issues.push({ appId, game, missing });
    }
  }
  if (!issues.length) {
    return [
      {
        content:
          "Every game I've seen so far has both roles and a channel linked.",
      },
    ];
  }

  issues.sort((a, b) => a.game.name.localeCompare(b.game.name));
  const messages = [];
  // A message holds 5 rows of 5 buttons.
  for (let i = 0; i < issues.length; i += 25) {
    const chunk = issues.slice(i, i + 25);
    const rows = [];
    for (let j = 0; j < chunk.length; j += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          chunk
            .slice(j, j + 5)
            .map(({ appId, game }) =>
              button(
                `game:link:${appId}`,
                game.name.slice(0, 80),
                ButtonStyle.Secondary,
              ),
            ),
        ),
      );
    }
    const lines = chunk.map(
      ({ game, missing }) =>
        `**${escapeMarkdown(game.name)}**: no ${missing.join(", no ")}`,
    );
    if (i === 0) {
      lines.unshift("Games missing something (press one to link it):");
    }
    messages.push({
      content: lines.join("\n"),
      components: rows,
      allowedMentions: NO_PINGS,
    });
  }
  return messages;
};

// `!adopt`, run once while the bot has Administrator: the bot can't see hidden
// game channels made by hand, so it adds itself to each one (a channel named
// after the no-permission role that opens it) and keeps seeing it afterwards.
// Known games get their channel linked.
const adoptChannels = async (guild, state) => {
  const me = guild.members.me;
  const adopted = [];
  const skipped = [];
  for (const channel of (await guild.channels.fetch()).values()) {
    const role = channel && channelGameRole(guild, channel);
    if (!role) {
      // Hidden and opened by a no-permission role, but named differently.
      const opener = channel?.permissionOverwrites?.cache.find(
        (o) =>
          o.allow.has(PermissionFlagsBits.ViewChannel) &&
          canHandOut(guild.roles.cache.get(o.id)),
      );
      if (
        opener &&
        channel.type === ChannelType.GuildText &&
        channel.permissionOverwrites.cache
          .get(guild.id)
          ?.deny.has(PermissionFlagsBits.ViewChannel)
      ) {
        skipped.push({ channel, role: guild.roles.cache.get(opener.id) });
      }
      continue;
    }

    if (
      !channel.permissionOverwrites.cache
        .get(me.id)
        ?.allow.has(PermissionFlagsBits.ViewChannel)
    ) {
      await channel.permissionOverwrites.edit(
        me,
        { ViewChannel: true },
        { reason: "Adopt game channel" },
      );
    }
    adopted.push({ channel, role });
    for (const [appId, game] of state.games) {
      if (
        game.status === "linked" &&
        game.roleId === role.id &&
        !game.channelId
      ) {
        store.setGame(guild.id, state, appId, {
          ...game,
          channelId: channel.id,
        });
      }
    }
  }
  return {
    adopted,
    skipped,
    sawEverything: me.permissions.has(PermissionFlagsBits.Administrator),
  };
};

const LINK_FIELDS = {
  linkrole: "roleId",
  linkingame: "ingameRoleId",
  linkchannel: "channelId",
};

const closeProposal = async (guild, game, content) => {
  const { channelId, messageId } = game.proposal || {};
  const channel = guild.channels.cache.get(channelId);
  await channel?.messages
    .edit(messageId, { content, components: [], allowedMentions: NO_PINGS })
    .catch(debug);
};

const handleGameInteraction = async (interaction) => {
  const [, action, appId] = interaction.customId.split(":");
  const { guild, user } = interaction;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "You need the Manage Roles permission for this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = await store.getGuildState(guild.id);
  const game = state.games.get(appId);
  const key = `${guild.id}:${appId}`;
  const answered = !game || game.status !== "proposed";
  const name = game && escapeMarkdown(game.name);

  if (action in LINK_FIELDS) {
    const id = interaction.values[0];
    if (!game || !id) {
      await interaction.deferUpdate();
      return;
    }
    if (action !== "linkchannel") {
      const role = guild.roles.cache.get(id);
      const isOwner = user.id === guild.ownerId;
      if (
        !canHandOut(role) ||
        (!isOwner &&
          interaction.member.roles.highest.comparePositionTo(role) <= 0)
      ) {
        await interaction.reply({
          content: "Pick a role with no permissions, below my role and yours.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    const next = { ...game, status: "linked", [LINK_FIELDS[action]]: id };
    store.setGame(guild.id, state, appId, next);
    await interaction.update({
      content: `Saved. **${name}**: ${summary(next)}`,
      allowedMentions: NO_PINGS,
    });
    await closeProposal(
      guild,
      next,
      `🔗 **${name}** linked by ${user}: ${summary(next)}`,
    );
    return;
  }

  // A proposal someone already answered: just take its buttons off.
  if (answered && action !== "link") {
    await interaction.update({ components: [] });
    return;
  }

  if (action === "link") {
    await interaction.reply({
      content: `Pick what **${name}** should use. Each choice saves right away.`,
      components: linkMenus(appId),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "ignore") {
    store.setGame(guild.id, state, appId, { ...game, status: "ignored" });
    await interaction.update({
      content: `🚫 **${name}** ignored by ${user}. I won't ask about it again.`,
      components: [],
      allowedMentions: NO_PINGS,
    });
    return;
  }

  if (busy.has(key)) {
    await interaction.reply({
      content: "Already on it.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  busy.add(key);
  await interaction.deferUpdate();
  try {
    const done = await createGame(
      guild,
      state,
      appId,
      game,
      action === "create",
    );
    await interaction.editReply({
      content: `✅ **${name}** set up by ${user}: ${summary(done)}`,
      components: [],
      allowedMentions: NO_PINGS,
    });
  } catch (error) {
    debug("failed to set up %s", game.name, error);
    Sentry.captureException(error);
    await interaction.followUp({
      content: `Couldn't set it up: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    });
  } finally {
    busy.delete(key);
  }
};

module.exports = {
  adoptChannels,
  gameCheck,
  handleGameInteraction,
  notePlayer,
  PROPOSAL_THRESHOLD,
};
