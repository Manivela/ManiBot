const { default: slugify } = require("slugify");
const { findChannel } = require("../utils/channel");
const { PermissionFlagsBits, ChannelType } = require("discord.js");
const debug = require("debug")("voiceStateUpdate");
const Sentry = require("@sentry/node");

// Keep track of voice channels and their members
const voiceChannelMembers = new Map();

const voiceStateUpdateHandler = async (oldState, newState, client) => {
  try {
    const newUserChannel = newState.channel;
    const oldUserChannel = oldState.channel;
    const userId = newState.member?.id;

    if (oldUserChannel === newUserChannel) {
      return;
    }

    if (!newState.member) {
      debug("Member not found in voice state update");
      return;
    }

    Sentry.setUser({
      id: userId,
      username: newState.member.displayName,
      discordUsername: newState.member?.user?.username,
    });

    // Track users joining voice channels
    if (newUserChannel) {
      const channelId = newUserChannel.id;
      if (!voiceChannelMembers.has(channelId)) {
        voiceChannelMembers.set(channelId, new Set());
      }
      voiceChannelMembers.get(channelId).add(userId);
      debug(
        `User ${userId} joined voice channel ${channelId}, now has ${voiceChannelMembers.get(channelId).size} members`
      );

      await handleUserJoinedVoiceChannel(newState, newUserChannel, client);
    }

    // Track users leaving voice channels
    if (oldUserChannel) {
      const channelId = oldUserChannel.id;
      if (voiceChannelMembers.has(channelId)) {
        voiceChannelMembers.get(channelId).delete(userId);
        debug(
          `User ${userId} left voice channel ${channelId}, now has ${voiceChannelMembers.get(channelId).size} members`
        );
      }

      await handleUserLeftVoiceChannel(oldState, newState, oldUserChannel);
    }
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "voiceStateUpdate",
        message: "Error handling voice state update",
      });
    });
    debug(`Error in voice state update handler: ${error.message}`);
  }
};

async function handleUserJoinedVoiceChannel(newState, voiceChannel, client) {
  const channelName = `${slugify(voiceChannel.name, { lower: true })}-manibot`;

  try {
    const foundChannel = findChannel(newState.guild.channels, channelName);

    if (foundChannel && voiceChannel.parentId === foundChannel.parentId) {
      await addUserToTextChannel(newState.member, foundChannel);
    } else {
      const doubleCheckChannel = findChannel(
        newState.guild.channels,
        channelName
      );
      if (
        doubleCheckChannel &&
        voiceChannel.parentId === doubleCheckChannel.parentId
      ) {
        await addUserToTextChannel(newState.member, doubleCheckChannel);
      } else {
        await createTextChannelForVoice(
          voiceChannel,
          channelName,
          newState,
          client
        );
      }
    }
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "voiceStateUpdate",
        message: `Error handling user join for ${newState.member.displayName} in ${voiceChannel.name}`,
      });
    });
    debug(`Error handling user join: ${error.message}`);
  }
}

async function addUserToTextChannel(member, textChannel) {
  try {
    await textChannel.permissionOverwrites.create(member, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    debug(`Added "${member.displayName}" to channel "${textChannel.name}"`);
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "voiceStateUpdate",
        message: `Failed to add permissions for ${member.displayName}`,
      });
    });
  }
}

async function createTextChannelForVoice(
  voiceChannel,
  channelName,
  newState,
  client
) {
  if (!voiceChannel.parent) {
    debug(`Voice channel ${voiceChannel.name} has no parent category`);
    return;
  }

  try {
    const existingChannel = findChannel(newState.guild.channels, channelName);
    if (existingChannel && voiceChannel.parentId === existingChannel.parentId) {
      debug(
        `Channel ${channelName} already exists, adding user to it instead of creating`
      );
      await addUserToTextChannel(newState.member, existingChannel);
      return;
    }

    const textChannel = await voiceChannel.parent.children.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: newState.member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: newState.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
      ],
    });

    debug(
      `Created channel "${textChannel.name}" for member "${newState.member.displayName}"`
    );

    // Add any other users already in the voice channel
    if (voiceChannelMembers.has(voiceChannel.id)) {
      const memberIds = Array.from(voiceChannelMembers.get(voiceChannel.id));
      for (const memberId of memberIds) {
        if (memberId !== newState.member.id) {
          const member = await newState.guild.members
            .fetch(memberId)
            .catch(() => null);
          if (member) {
            await addUserToTextChannel(member, textChannel);
          }
        }
      }
    }
  } catch (error) {
    if (error.code === 10008) {
      debug(
        `Race condition detected: Channel ${channelName} was created by another process`
      );
      const retryChannel = findChannel(newState.guild.channels, channelName);
      if (retryChannel) {
        await addUserToTextChannel(newState.member, retryChannel);
      }
    } else {
      Sentry.captureException(error, (scope) => {
        scope.addBreadcrumb({
          level: "error",
          type: "debug",
          category: "voiceStateUpdate",
          message: `Failed to create channel ${channelName}`,
        });
      });
      debug(`Error creating channel: ${error.message}`);
    }
  }
}

async function handleUserLeftVoiceChannel(oldState, newState, voiceChannel) {
  const channelName = `${slugify(voiceChannel.name, { lower: true })}-manibot`;
  const foundChannel = findChannel(newState.guild.channels, channelName);

  if (!foundChannel) {
    return;
  }

  debug(`Found channel ${foundChannel.name}`);

  if (voiceChannel.parentId !== foundChannel.parentId) {
    return;
  }

  // Use our own tracking to determine if the channel is empty
  const membersInChannel = voiceChannelMembers.has(voiceChannel.id)
    ? voiceChannelMembers.get(voiceChannel.id).size
    : 0;

  debug(
    `Voice channel ${voiceChannel.name} has ${membersInChannel} members after user left (our tracking)`
  );

  if (membersInChannel === 0) {
    debug(
      `Confirmed voice channel ${voiceChannel.name} is empty, deleting text channel`
    );
    await deleteEmptyChannel(foundChannel, channelName);
  } else {
    debug(
      `Voice channel ${voiceChannel.name} still has ${membersInChannel} members, keeping text channel`
    );
    await removeUserFromChannel(newState.member, foundChannel);
  }
}

async function deleteEmptyChannel(textChannel, channelName) {
  try {
    await textChannel.delete();
    debug(`Removed channel "${textChannel.name}"`);
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "voiceStateUpdate",
        message: `Failed to delete channel ${channelName}`,
      });
    });
  }
}

async function removeUserFromChannel(member, textChannel) {
  try {
    await textChannel.permissionOverwrites.delete(member);
    debug(`Removed "${member.displayName}" from channel "${textChannel.name}"`);
  } catch (error) {
    Sentry.captureException(error, (scope) => {
      scope.addBreadcrumb({
        level: "error",
        type: "debug",
        category: "voiceStateUpdate",
        message: `Failed to remove permissions for ${member.displayName}`,
      });
    });
  }
}

module.exports = { voiceStateUpdateHandler };
