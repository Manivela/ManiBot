const { hasRole, findRole } = require("../utils/role");
const debug = require("debug")("presenceUpdate");
const Sentry = require("@sentry/node");

const presenceUpdateHandler = async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member) {
      debug("Member not found in presence update");
      return;
    }

    Sentry.setUser({
      id: member.id,
      username: member.displayName,
      discordUsername: member?.user?.username,
    });

    const stoppedActivities = oldPresence
      ? oldPresence.activities.filter(
          (oldActivity) =>
            !newPresence.activities.find(
              (newActivity) => newActivity.id === oldActivity.id
            )
        )
      : [];

    await handleNewActivities(newPresence);
    await handleStoppedActivities(
      member,
      stoppedActivities,
      newPresence.guild.roles
    );
    await cleanupLeftoverRoles(member, newPresence.activities);
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "presenceUpdate",
        message: "Error handling presence update",
      });
    });
    debug(`Error in presence update handler: ${error.message}`);
  }
};

async function handleNewActivities(newPresence) {
  const member = newPresence.member;
  const guildRoles = newPresence.guild.roles;

  for (const activity of newPresence.activities) {
    if (!activity.applicationId) continue;

    if (!hasRole(member, activity.name)) {
      const role = await findRole(guildRoles, activity.name);
      if (role) {
        await member.roles.add(role);
        debug(`Role "${role.name}" added to "${member.displayName}".`);
      }
    }

    const ingameRoleName = `${activity.name}-ingame`;
    if (!hasRole(member, ingameRoleName)) {
      const inGameRole = await findRole(guildRoles, ingameRoleName);
      if (inGameRole) {
        await member.roles.add(inGameRole);
        debug(
          `In-game role "${inGameRole.name}" added to "${member.displayName}".`
        );
      }
    }
  }
}

async function handleStoppedActivities(member, stoppedActivities, guildRoles) {
  for (const activity of stoppedActivities) {
    if (!activity.applicationId) continue;

    const ingameRoleName = `${activity.name}-ingame`;
    if (hasRole(member, ingameRoleName)) {
      const inGameRole = await findRole(guildRoles, ingameRoleName);
      if (inGameRole) {
        await member.roles.remove(inGameRole);
        debug(
          `In-game role "${inGameRole.name}" removed from "${member.displayName}".`
        );
      }
    }
  }
}

async function cleanupLeftoverRoles(member, activities) {
  const currentActivityNames = activities
    .filter((activity) => activity.applicationId)
    .map((activity) => activity.name);

  const rolesToRemove = member.roles.cache.filter(
    (role) =>
      role.name.endsWith("-ingame") &&
      !currentActivityNames.some(
        (activityName) => role.name === `${activityName}-ingame`
      )
  );

  for (const role of rolesToRemove.values()) {
    await member.roles.remove(role);
    debug(
      `Leftover in-game role "${role.name}" removed from "${member.displayName}".`
    );
  }
}

module.exports = { presenceUpdateHandler };
