// The #roles picker: one fixed button; pressing it opens a private reply with
// lists of the guild's game roles (plus extras like DJ), ticked as the member
// has them. The lists are built on each press, so the menu is never stale.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");
const debug = require("debug")("games:picker");
const store = require("./store");

const OPTIONS_PER_LIST = 25;
const MAX_LISTS = 5;
const LIST_HELP = "Tick what you play. Changes save when you close a list.";

// Anyone can pick these, so only roles that grant no permissions and that the
// bot may hand out.
const canHandOut = (role) =>
  Boolean(role) &&
  role.editable &&
  !role.managed &&
  role.id !== role.guild.id &&
  role.permissions.bitfield === 0n;

const squash = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// A text channel hidden from @everyone and opened by a no-permission role
// named like it (#among-us ↔ "Among Us") is that role's game channel. The name
// check keeps other private channels' roles out of the picker.
const channelGameRole = (guild, channel) => {
  const overwrites = channel?.permissionOverwrites?.cache;
  if (
    channel.type !== ChannelType.GuildText ||
    !overwrites?.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel)
  ) {
    return undefined;
  }
  return overwrites
    .filter((o) => o.allow.has(PermissionFlagsBits.ViewChannel))
    .map((o) => guild.roles.cache.get(o.id))
    .find(
      (role) => canHandOut(role) && squash(role.name) === squash(channel.name),
    );
};

const pickableRoles = (guild, state) => {
  const ids = new Set(state.config.extraRoleIds || []);
  for (const game of state.games.values()) {
    if (game.status === "linked" && game.roleId) {
      ids.add(game.roleId);
    }
  }
  // Pairs made by hand ("X" with an "X-ingame" twin) count before anyone has
  // played the game since the bot started tracking.
  const byName = new Map(guild.roles.cache.map((role) => [role.name, role]));
  for (const name of byName.keys()) {
    const plain = name.endsWith("-ingame") && byName.get(name.slice(0, -7));
    if (plain) {
      ids.add(plain.id);
    }
  }
  // Roles that open a game channel the bot can see (see `!adopt`).
  for (const channel of guild.channels.cache.values()) {
    const role = channelGameRole(guild, channel);
    if (role) {
      ids.add(role.id);
    }
  }
  return [...ids]
    .map((id) => guild.roles.cache.get(id))
    .filter(canHandOut)
    .sort((a, b) => a.name.localeCompare(b.name));
};

// shortcut: a reply fits 5 lists of 25, so roles past 125 are left out; page the lists when a server gets there.
const buildLists = (roles, hasRole) => {
  const rows = [];
  for (
    let i = 0;
    i < roles.length && rows.length < MAX_LISTS;
    i += OPTIONS_PER_LIST
  ) {
    const chunk = roles.slice(i, i + OPTIONS_PER_LIST);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`roles:pick:${rows.length}`)
          .setPlaceholder(
            `${chunk[0].name} – ${chunk.at(-1).name}`.slice(0, 150),
          )
          .setMinValues(0)
          .setMaxValues(chunk.length)
          .addOptions(
            chunk.map((role) => ({
              label: role.name.slice(0, 100),
              value: role.id,
              default: hasRole(role.id),
            })),
          ),
      ),
    );
  }
  return rows;
};

const pickerMessage = () => ({
  content:
    "**Pick your games**\nChoose the games you play to see their channels. You can change it any time.",
  components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("roles:open")
        .setLabel("Pick your roles")
        .setStyle(ButtonStyle.Primary),
    ),
  ],
});

// The picker lives in its own channel, set up while @everyone can't see it so
// nobody is notified or sees it half-done, then shown. Running it again
// reuses the channel (wherever it's been moved or renamed) and swaps the
// message. Returns the channel.
const setUpPicker = async (guild, state) => {
  const reason = "Role picker channel";
  const everyone = guild.roles.everyone;
  const old = state.config.picker;
  let channel = old && guild.channels.cache.get(old.channelId);
  // A channel kept private on purpose stays private.
  const keepHidden = Boolean(
    channel?.permissionOverwrites.cache
      .get(everyone.id)
      ?.deny.has(PermissionFlagsBits.ViewChannel),
  );
  const locked = {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  };

  if (channel) {
    await channel.permissionOverwrites.edit(
      everyone,
      { ViewChannel: false, ...locked },
      { reason },
    );
    await channel.messages.delete(old.messageId).catch(debug);
  } else {
    channel = await guild.channels.create({
      name: "roles",
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
          ],
        },
        {
          id: guild.members.me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ],
        },
      ],
      reason,
    });
  }
  await channel.permissionOverwrites.edit(
    guild.members.me,
    { ViewChannel: true, SendMessages: true },
    { reason },
  );

  const message = await channel.send(pickerMessage());
  store.setConfig(guild.id, state, {
    picker: { channelId: channel.id, messageId: message.id },
  });
  await channel.permissionOverwrites.edit(
    everyone,
    { ViewChannel: keepHidden ? false : null },
    { reason },
  );
  return channel;
};

const handleRolesInteraction = async (interaction) => {
  const { guild, member } = interaction;
  const state = await store.getGuildState(guild.id);

  if (interaction.customId === "roles:open") {
    const roles = pickableRoles(guild, state);
    await interaction.reply({
      content: roles.length ? LIST_HELP : "There's nothing to pick yet.",
      components: buildLists(roles, (id) => member.roles.cache.has(id)),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.isStringSelectMenu()) {
    return;
  }

  // Only this list's roles (the others sit in their own lists), and only ones
  // still pickable: the list may be older than the last change.
  const pickable = new Set(pickableRoles(guild, state).map((role) => role.id));
  const listed = interaction.component.options
    .map((option) => option.value)
    .filter((id) => pickable.has(id));
  const chosen = new Set(interaction.values);
  const add = listed.filter(
    (id) => chosen.has(id) && !member.roles.cache.has(id),
  );
  const remove = listed.filter(
    (id) => !chosen.has(id) && member.roles.cache.has(id),
  );

  await interaction.deferUpdate();
  // One role at a time: a whole-list update could drop an in-game role the
  // presence handler adds meanwhile.
  for (const id of add) {
    await member.roles.add(id, "Role picker");
    store.setOptOut(guild.id, state, member.id, id, false);
  }
  for (const id of remove) {
    await member.roles.remove(id, "Role picker");
    store.setOptOut(guild.id, state, member.id, id, true);
  }

  const hasRole = (id) =>
    !remove.includes(id) && (add.includes(id) || member.roles.cache.has(id));
  await interaction.editReply({
    content: LIST_HELP,
    components: buildLists(pickableRoles(guild, state), hasRole),
  });
};

module.exports = {
  canHandOut,
  channelGameRole,
  handleRolesInteraction,
  pickableRoles,
  pickerMessage,
  setUpPicker,
};
