const { ActivityType } = require("discord.js");
const debug = require("debug")("presenceUpdate");
const Sentry = require("@sentry/node");
const store = require("../games/store");
const { notePlayer } = require("../games/proposals");
const { canHandOut, channelGameRole } = require("../games/picker");

// The roles set up for this game. The first time a game is seen, roles named
// exactly after it ("X", "X-ingame") are linked; a part still missing is
// looked up again each time, so a role made by hand later gets picked up.
// Null while the game is unknown, proposed or ignored. Any app can name its
// activity after a game, so only roles without permissions are handed out.
const resolveGame = (guild, state, activity) => {
  const appId = activity.applicationId;
  const game = state.games.get(appId);
  if (game && game.status !== "linked") {
    return null;
  }

  const roles = guild.roles.cache;
  const byName = (name) =>
    roles.find((role) => role.name === name && canHandOut(role))?.id;
  const roleId = roles.has(game?.roleId) ? game.roleId : byName(activity.name);
  const ingameRoleId = roles.has(game?.ingameRoleId)
    ? game.ingameRoleId
    : byName(`${activity.name}-ingame`);
  if (!game && !roleId && !ingameRoleId) {
    return null;
  }
  // The channel its role opens, once the bot can see it (see `!adopt`).
  const channelId =
    game?.channelId ??
    (roleId &&
      guild.channels.cache.find(
        (channel) => channelGameRole(guild, channel)?.id === roleId,
      )?.id);
  if (
    game &&
    roleId === game.roleId &&
    ingameRoleId === game.ingameRoleId &&
    channelId === game.channelId
  ) {
    return game;
  }

  const linked = {
    ...game,
    status: "linked",
    name: game?.name ?? activity.name,
    roleId,
    ingameRoleId,
    channelId,
  };
  store.setGame(guild.id, state, appId, linked);
  return linked;
};

const presenceUpdateHandler = async (oldPresence, newPresence) => {
  const member = newPresence.member;
  if (!member || member.user?.bot) {
    return;
  }
  Sentry.setUser({
    id: member.id,
    username: member.displayName,
    discordUsername: member?.user?.username,
  });

  const guild = newPresence.guild;
  let state;
  try {
    state = await store.getGuildState(guild.id);
  } catch {
    return; // the store reported it; nothing happens until it can be read
  }

  const playingIngameRoles = new Set();
  for (const activity of newPresence.activities) {
    if (!activity.applicationId) {
      continue;
    }
    const game = resolveGame(guild, state, activity);
    if (!game) {
      if (activity.type === ActivityType.Playing) {
        await notePlayer(guild, state, activity, member);
      }
      continue;
    }

    const role = guild.roles.cache.get(game.roleId);
    if (
      canHandOut(role) &&
      !member.roles.cache.has(role.id) &&
      !store.isOptedOut(state, member.id, role.id)
    ) {
      await member.roles.add(role);
      debug(`Role "${role.name}" added to "${member.displayName}".`);
    }

    const ingameRole = guild.roles.cache.get(game.ingameRoleId);
    if (canHandOut(ingameRole)) {
      playingIngameRoles.add(ingameRole.id);
      if (!member.roles.cache.has(ingameRole.id)) {
        await member.roles.add(ingameRole);
        debug(
          `In-game role "${ingameRole.name}" added to "${member.displayName}".`,
        );
      }
    }
  }

  // In-game roles of games no longer played, including "-ingame" roles from
  // before the game list.
  const ingameRoleIds = new Set(
    [...state.games.values()].map((game) => game.ingameRoleId),
  );
  for (const role of member.roles.cache.values()) {
    if (
      (ingameRoleIds.has(role.id) || role.name.endsWith("-ingame")) &&
      !playingIngameRoles.has(role.id)
    ) {
      await member.roles.remove(role);
      debug(
        `In-game role "${role.name}" removed from "${member.displayName}".`,
      );
    }
  }
};
module.exports = { presenceUpdateHandler };
