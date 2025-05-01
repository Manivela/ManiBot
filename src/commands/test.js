const { createMockClient } = require("../testing/mockPresence");
const { createVoiceMock } = require("../testing/mockVoice");

let mockPresence = null;
let mockVoice = null;

const testCommand = {
  name: "test",
  description:
    "Command for testing bot features without needing multiple accounts",
  execute(message, args, client) {
    if (!mockPresence) mockPresence = createMockClient(client);
    if (!mockVoice) mockVoice = createVoiceMock(client);

    if (!args.length) {
      return message.reply(
        `Available test commands:
• \`!test presence start <game_name>\` - Simulate starting a game
• \`!test presence stop\` - Simulate stopping a game
• \`!test voice join <channel_id>\` - Simulate joining a voice channel
• \`!test voice leave <channel_id>\` - Simulate leaving a voice channel
• \`!test voice move <from_id> <to_id>\` - Simulate moving between channels
• \`!test voice other-join <user_id> <channel_id>\` - Simulate another user joining
• \`!test voice other-leave <user_id> <channel_id>\` - Simulate another user leaving
• \`!test voice multi-join <channel_id> <user_id1> <user_id2> ...\` - Multiple users join
• \`!test voice multi-leave <channel_id> <user_id1> <user_id2> ...\` - Multiple users leave
• \`!test voice debug <channel_id>\` - Display debug info about voice channel
• \`!test user-list\` - List all users in the server with their IDs`
      );
    }

    const category = args[0].toLowerCase();
    const action = args[1]?.toLowerCase();
    const userId = message.author.id;
    const guildId = message.guild.id;

    try {
      switch (category) {
        case "presence":
          handlePresenceTest(action, message, args, userId, guildId);
          break;
        case "voice":
          handleVoiceTest(action, message, args, userId, guildId);
          break;
        case "user-list":
          handleUserList(message);
          break;
        default:
          message.reply(
            "Unknown test category. Use `!test` to see available commands."
          );
      }
    } catch (error) {
      console.error("Test command error:", error);
      message.reply(`Error executing test command: ${error.message}`);
    }
  },
};

function handlePresenceTest(action, message, args, userId, guildId) {
  switch (action) {
    case "start": {
      const gameName = args.slice(2).join(" ") || "Test Game";
      mockPresence.simulatePresenceUpdate(userId, guildId, {
        name: gameName,
        id: `mock-${Date.now()}`,
        applicationId: "mock-app-id",
      });
      message.reply(`Simulating you playing ${gameName}`);
      break;
    }
    case "stop":
      mockPresence.stopActivity(userId, guildId, "mock-app-id");
      message.reply("Simulating you stopping your current game");
      break;
    default:
      message.reply(
        "Unknown presence action. Use `!test` to see available commands."
      );
  }
}

function handleVoiceTest(action, message, args, userId, guildId) {
  switch (action) {
    case "join": {
      const joinChannelId = args[2];
      if (!joinChannelId) {
        return message.reply("Please provide a channel ID");
      }

      const result = mockVoice.simulateJoinVoice(
        userId,
        guildId,
        joinChannelId
      );
      if (result) {
        message.reply(`Simulating you joining voice channel ${joinChannelId}`);
      }
      break;
    }
    case "leave": {
      const leaveChannelId = args[2];
      if (!leaveChannelId) {
        return message.reply("Please provide a channel ID");
      }

      mockVoice.simulateLeaveVoice(userId, guildId, leaveChannelId);
      message.reply(`Simulating you leaving voice channel ${leaveChannelId}`);
      break;
    }
    case "move": {
      const fromChannelId = args[2];
      const toChannelId = args[3];
      if (!fromChannelId || !toChannelId) {
        return message.reply("Please provide both from and to channel IDs");
      }

      mockVoice.simulateMoveVoice(userId, guildId, fromChannelId, toChannelId);
      message.reply(
        `Simulating you moving from ${fromChannelId} to ${toChannelId}`
      );
      break;
    }
    case "other-join": {
      const targetUserId = args[2];
      const channelId = args[3];
      if (!targetUserId || !channelId) {
        return message.reply("Please provide both user ID and channel ID");
      }

      const result = mockVoice.simulateOtherUserJoin(
        targetUserId,
        guildId,
        channelId
      );
      if (result) {
        const member = message.guild.members.cache.get(targetUserId);
        const memberName = member ? member.displayName : targetUserId;
        message.reply(
          `Simulating ${memberName} joining voice channel ${channelId}`
        );
      }
      break;
    }
    case "other-leave": {
      const targetUserId = args[2];
      const channelId = args[3];
      if (!targetUserId || !channelId) {
        return message.reply("Please provide both user ID and channel ID");
      }

      const result = mockVoice.simulateOtherUserLeave(
        targetUserId,
        guildId,
        channelId
      );
      if (result) {
        const member = message.guild.members.cache.get(targetUserId);
        const memberName = member ? member.displayName : targetUserId;
        message.reply(
          `Simulating ${memberName} leaving voice channel ${channelId}`
        );
      }
      break;
    }
    case "multi-join": {
      const channelId = args[2];
      const userIds = args.slice(3);
      if (!channelId || userIds.length === 0) {
        return message.reply(
          "Please provide a channel ID and at least one user ID"
        );
      }

      const result = mockVoice.simulateMultiUserJoin(
        userIds,
        guildId,
        channelId
      );
      if (result) {
        message.reply(
          `Simulating multiple users joining voice channel ${channelId}`
        );
      }
      break;
    }
    case "multi-leave": {
      const channelId = args[2];
      const userIds = args.slice(3);
      if (!channelId || userIds.length === 0) {
        return message.reply(
          "Please provide a channel ID and at least one user ID"
        );
      }

      const result = mockVoice.simulateMultiUserLeave(
        userIds,
        guildId,
        channelId
      );
      if (result) {
        message.reply(
          `Simulating multiple users leaving voice channel ${channelId}`
        );
      }
      break;
    }
    case "debug": {
      const channelId = args[2];
      if (!channelId) {
        return message.reply("Please provide a channel ID");
      }

      const debugInfo = mockVoice.debugChannelMembers(channelId, guildId);
      if (typeof debugInfo === "string") {
        message.reply(debugInfo);
        return;
      }

      const {
        channelName,
        trackedMemberCount,
        channelMembersSize,
        manualCount,
        channelMembersKeys,
      } = debugInfo;

      const response = [
        `**Debug info for voice channel: ${channelName}**`,
        `- Our tracking shows ${trackedMemberCount} members`,
        `- Channel members size reports ${channelMembersSize}`,
        `- Manual count of members: ${manualCount}`,
        `- Member IDs in channel: ${channelMembersKeys.join(", ") || "none"}`,
      ];

      message.reply(response.join("\n"));
      break;
    }
    default:
      message.reply(
        "Unknown voice action. Use `!test` to see available commands."
      );
  }
}

function handleUserList(message) {
  const members = message.guild.members.cache;

  if (members.size === 0) {
    return message.reply("Unable to fetch members. Try again later.");
  }

  const userChunks = [];
  let currentChunk = "";

  members.forEach((member) => {
    const line = `${member.user.tag} (${member.displayName}): \`${member.id}\`\n`;

    // Discord has a 2000 char limit per message
    if (currentChunk.length + line.length > 1900) {
      userChunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += line;
    }
  });

  if (currentChunk.length > 0) {
    userChunks.push(currentChunk);
  }

  message.reply(`Server has ${members.size} members. Here's the list:`);

  for (const chunk of userChunks) {
    message.channel.send(chunk);
  }
}

module.exports = testCommand;
