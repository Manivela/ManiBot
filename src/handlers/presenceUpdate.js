const { hasRole, findRole } = require("../utils/role");
const debug = require("debug")("presenceUpdate");
const Sentry = require("@sentry/node");

const presenceUpdateHandler = async (oldPresence, newPresence) => {
  const member = newPresence.member;
  Sentry.setUser({
    id: member.id,
    username: member.displayName,
    discordUsername: member?.user?.username,
  });

  // Filter out the activities that are no longer present
  const stoppedActivities = oldPresence
    ? oldPresence.activities.filter(
        (oldActivity) =>
          !newPresence.activities.find(
            (newActivity) => newActivity.id === oldActivity.id,
          ),
      )
    : [];

  // Handle newly started activities
  for (const activity of newPresence.activities) {
    if (activity.applicationId && !hasRole(member, activity.name)) {
      const role = await findRole(newPresence.guild.roles, activity.name);
      if (role) {
        await member.roles.add(role);
        debug(`Role "${role.name}" added to "${member.displayName}".`);
      }
    }
    if (activity.applicationId && !hasRole(member, `${activity.name}-ingame`)) {
      const inGameRole = await findRole(
        newPresence.guild.roles,
        `${activity.name}-ingame`,
      );
      if (inGameRole) {
        await member.roles.add(inGameRole);
        debug(
          `In-game role "${inGameRole.name}" added to "${member.displayName}".`,
        );
      }
    }
  }

  // Handle activities that have stopped
  for (const activity of stoppedActivities) {
    if (activity.applicationId && hasRole(member, `${activity.name}-ingame`)) {
      const inGameRole = await findRole(
        newPresence.guild.roles,
        `${activity.name}-ingame`,
      );
      if (inGameRole) {
        await member.roles.remove(inGameRole);
        debug(
          `In-game role "${inGameRole.name}" removed from "${member.displayName}".`,
        );
      }
    }
  }

  // Cleanup section for leftover -ingame roles that are not part of the current activity
  const currentActivitiesNames = newPresence.activities
    .filter((activity) => activity.applicationId)
    .map((activity) => activity.name);

  const rolesToRemove = member.roles.cache.filter(
    (role) =>
      role.name.endsWith("-ingame") &&
      !currentActivitiesNames.some(
        (activityName) => role.name === `${activityName}-ingame`,
      ),
  );

  for (const role of rolesToRemove.values()) {
    await member.roles.remove(role);
    debug(
      `Leftover in-game role "${role.name}" removed from "${member.displayName}".`,
    );
  }
};
module.exports = { presenceUpdateHandler };
