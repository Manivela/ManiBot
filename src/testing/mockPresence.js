const { Client, ActivityType } = require("discord.js");

function createMockClient(client) {
  if (!(client instanceof Client)) {
    throw new Error("Parameter must be a Discord.js Client");
  }

  return {
    simulatePresenceUpdate(userId, guildId, activityOptions) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error(`Guild with ID ${guildId} not found`);
        return false;
      }

      const member = guild.members.cache.get(userId);
      if (!member) {
        console.error(
          `Member with ID ${userId} not found in guild ${guild.name}`
        );
        return false;
      }

      const oldPresence = member.presence;

      const mockActivity = {
        id: activityOptions.id || `mock-${Date.now()}`,
        name: activityOptions.name || "Mock Game",
        type: activityOptions.type || ActivityType.Playing,
        applicationId: activityOptions.applicationId || "mock-app-id",
        createdTimestamp: Date.now(),
      };

      const newPresence = {
        activities: [mockActivity],
        clientStatus: { desktop: "online", mobile: null, web: null },
        guild,
        member,
        status: activityOptions.status || "online",
        userId: member.id,
        user: member.user,
      };

      console.log(
        `Simulating presence update for ${member.displayName} with activity ${mockActivity.name}`
      );

      client.emit("presenceUpdate", oldPresence, newPresence);
      return true;
    },

    stopActivity(userId, guildId, activityId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error(`Guild with ID ${guildId} not found`);
        return false;
      }

      const member = guild.members.cache.get(userId);
      if (!member) {
        console.error(
          `Member with ID ${userId} not found in guild ${guild.name}`
        );
        return false;
      }

      const activityName =
        member.presence?.activities.find((a) => a.applicationId === activityId)
          ?.name || "Mock Game";

      const oldPresence = {
        activities: [
          {
            id: activityId,
            name: activityName,
            type: ActivityType.Playing,
            applicationId: activityId || "mock-app-id",
          },
        ],
        clientStatus: { desktop: "online", mobile: null, web: null },
        guild,
        member,
        status: "online",
        userId: member.id,
        user: member.user,
      };

      const newPresence = {
        activities: [],
        clientStatus: { desktop: "online", mobile: null, web: null },
        guild,
        member,
        status: "online",
        userId: member.id,
        user: member.user,
      };

      console.log(`Simulating stopped activity for ${member.displayName}`);
      client.emit("presenceUpdate", oldPresence, newPresence);

      return true;
    },
  };
}

module.exports = { createMockClient };
