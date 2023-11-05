const { hasRole, findRole } = require("../utils/role");

const presenceUpdateHandler = async (oldPresence, newPresence) => {
  const member = newPresence.member;

  // Filter out the activities that are no longer present
  const stoppedActivities = oldPresence
    ? oldPresence.activities.filter(
        (oldActivity) =>
          !newPresence.activities.find(
            (newActivity) => newActivity.id === oldActivity.id
          )
      )
    : [];

  // Handle newly started activities
  for (const activity of newPresence.activities) {
    if (activity.applicationId && !hasRole(member, activity.name)) {
      const role = await findRole(newPresence.guild.roles, activity.name);
      if (role) {
        await member.roles.add(role);
        console.log(`Role "${role.name}" added to "${member.displayName}".`);
      }
    }
    if (activity.applicationId && !hasRole(member, `${activity.name}-ingame`)) {
      const inGameRole = await findRole(
        newPresence.guild.roles,
        `${activity.name}-ingame`
      );
      if (inGameRole) {
        await member.roles.add(inGameRole);
        console.log(
          `In-game role "${inGameRole.name}" added to "${member.displayName}".`
        );
      }
    }
  }

  // Handle activities that have stopped
  for (const activity of stoppedActivities) {
    if (activity.applicationId && hasRole(member, `${activity.name}-ingame`)) {
      const inGameRole = await findRole(
        newPresence.guild.roles,
        `${activity.name}-ingame`
      );
      if (inGameRole) {
        await member.roles.remove(inGameRole);
        console.log(
          `In-game role "${inGameRole.name}" removed from "${member.displayName}".`
        );
      }
    }
  }
};
module.exports = { presenceUpdateHandler };
