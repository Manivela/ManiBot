const { Client, Collection } = require("discord.js");

// Helper function to add delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createVoiceMock(client) {
  if (!(client instanceof Client)) {
    throw new Error("Parameter must be a Discord.js Client");
  }

  // Track which members are in which channels
  const voiceChannelMembers = new Map();

  return {
    async simulateJoinVoice(userId, guildId, channelId) {
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

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.error(
          `Channel with ID ${channelId} not found in guild ${guild.name}`
        );
        return false;
      }

      // Update our member tracking
      if (!voiceChannelMembers.has(channelId)) {
        voiceChannelMembers.set(channelId, new Set());
      }
      voiceChannelMembers.get(channelId).add(userId);

      // Ensure the channel has a properly initialized members collection
      if (!channel.members) {
        channel.members = new Collection();
      }

      // Add the member to the channel's members Collection
      channel.members.set(userId, member);

      // Create a real size getter that accurately reports member count
      Object.defineProperty(channel.members, "size", {
        configurable: true,
        get: () => voiceChannelMembers.get(channelId).size,
      });

      const oldState = {
        guild,
        member,
        channel: null,
        channelId: null,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId: null,
        streaming: false,
        suppress: false,
      };

      const newState = {
        guild,
        member,
        channel,
        channelId: channel.id,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId: `mock-session-${Date.now()}`,
        streaming: false,
        suppress: false,
      };

      console.log(
        `Simulating ${member.displayName} joining voice channel ${channel.name} (${voiceChannelMembers.get(channelId).size} members)`
      );
      client.emit("voiceStateUpdate", oldState, newState);
      return true;
    },

    async simulateLeaveVoice(userId, guildId, channelId) {
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

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.error(
          `Channel with ID ${channelId} not found in guild ${guild.name}`
        );
        return false;
      }

      // Update our member tracking
      if (voiceChannelMembers.has(channelId)) {
        voiceChannelMembers.get(channelId).delete(userId);
      }

      // Remove the member from the channel's members Collection
      if (channel.members) {
        channel.members.delete(userId);

        // Update the size property
        const remainingMembers = voiceChannelMembers.get(channelId)?.size || 0;
        Object.defineProperty(channel.members, "size", {
          configurable: true,
          get: () => remainingMembers,
        });
      }

      const oldState = {
        guild,
        member,
        channel,
        channelId: channel.id,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId: `mock-session-${Date.now()}`,
        streaming: false,
        suppress: false,
      };

      const newState = {
        guild,
        member,
        channel: null,
        channelId: null,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId: null,
        streaming: false,
        suppress: false,
      };

      const remainingMembers = voiceChannelMembers.has(channelId)
        ? voiceChannelMembers.get(channelId).size
        : 0;
      console.log(
        `Simulating ${member.displayName} leaving voice channel ${channel.name} (${remainingMembers} members remaining)`
      );

      // Debug information to help troubleshoot
      console.log(
        `Debug: Voice channel members collection size property returns: ${channel.members.size}`
      );
      let manualCount = 0;
      channel.members.forEach(() => manualCount++);
      console.log(`Debug: Manual count of channel members: ${manualCount}`);
      console.log(`Debug: Our tracking shows ${remainingMembers} members`);

      client.emit("voiceStateUpdate", oldState, newState);
      return true;
    },

    simulateMoveVoice(userId, guildId, fromChannelId, toChannelId) {
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

      const fromChannel = guild.channels.cache.get(fromChannelId);
      if (!fromChannel) {
        console.error(
          `Channel with ID ${fromChannelId} not found in guild ${guild.name}`
        );
        return false;
      }

      const toChannel = guild.channels.cache.get(toChannelId);
      if (!toChannel) {
        console.error(
          `Channel with ID ${toChannelId} not found in guild ${guild.name}`
        );
        return false;
      }

      const sessionId = `mock-session-${Date.now()}`;

      const oldState = {
        guild,
        member,
        channel: fromChannel,
        channelId: fromChannel.id,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId,
        streaming: false,
        suppress: false,
      };

      const newState = {
        guild,
        member,
        channel: toChannel,
        channelId: toChannel.id,
        id: userId,
        serverDeaf: false,
        serverMute: false,
        selfDeaf: false,
        selfMute: false,
        selfVideo: false,
        sessionId,
        streaming: false,
        suppress: false,
      };

      console.log(
        `Simulating ${member.displayName} moving from ${fromChannel.name} to ${toChannel.name}`
      );
      client.emit("voiceStateUpdate", oldState, newState);
      return true;
    },

    simulateOtherUserJoin(targetUserId, guildId, channelId) {
      return this.simulateJoinVoice(targetUserId, guildId, channelId);
    },

    simulateOtherUserLeave(targetUserId, guildId, channelId) {
      return this.simulateLeaveVoice(targetUserId, guildId, channelId);
    },

    async simulateMultiUserJoin(userIds, guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error(`Guild with ID ${guildId} not found`);
        return false;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.error(
          `Channel with ID ${channelId} not found in guild ${guild.name}`
        );
        return false;
      }

      let successCount = 0;

      // Use sequential execution with delay
      for (const userId of userIds) {
        // Add a delay of 500ms between each user join to prevent race conditions
        await delay(500);

        // First user creates the channel, others should get added to it
        const success = await this.simulateJoinVoice(
          userId,
          guildId,
          channelId
        );
        if (success) successCount++;
      }

      console.log(
        `Simulated ${successCount}/${userIds.length} users joining ${channel.name}`
      );
      return successCount > 0;
    },

    async simulateMultiUserLeave(userIds, guildId, channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.error(`Guild with ID ${guildId} not found`);
        return false;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.error(
          `Channel with ID ${channelId} not found in guild ${guild.name}`
        );
        return false;
      }

      let successCount = 0;

      // Leave in reverse order with delay
      for (let i = userIds.length - 1; i >= 0; i--) {
        await delay(300);
        const success = await this.simulateLeaveVoice(
          userIds[i],
          guildId,
          channelId
        );
        if (success) successCount++;
      }

      console.log(
        `Simulated ${successCount}/${userIds.length} users leaving ${channel.name}`
      );
      return successCount > 0;
    },

    getChannelMemberCount(channelId) {
      return voiceChannelMembers.has(channelId)
        ? voiceChannelMembers.get(channelId).size
        : 0;
    },

    // Method to debug and inspect channel member state
    debugChannelMembers(channelId, guildId) {
      const channel = client.guilds.cache
        .get(guildId)
        ?.channels.cache.get(channelId);
      if (!channel) return "Channel not found";

      const trackedMembers = voiceChannelMembers.get(channelId);
      const channelMembersSize = channel.members?.size;

      let manualCount = 0;
      if (channel.members) {
        channel.members.forEach(() => manualCount++);
      }

      return {
        channelId,
        channelName: channel.name,
        trackedMemberCount: trackedMembers ? trackedMembers.size : 0,
        trackedMembersArray: trackedMembers ? Array.from(trackedMembers) : [],
        channelMembersSize,
        manualCount,
        channelMembersKeys: channel.members
          ? Array.from(channel.members.keys())
          : [],
      };
    },
  };
}

module.exports = { createVoiceMock };
