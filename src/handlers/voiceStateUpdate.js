const { default: slugify } = require("slugify");
const { findChannel } = require("../utils/channel");
const { PermissionFlagsBits, ChannelType } = require("discord.js");
const debug = require("debug")("voiceStateUpdate");

const voiceStateUpdateHandler = async (oldState, newState, client) => {
  const newUserChannel = newState.channel;
  const oldUserChannel = oldState.channel;
  if (oldUserChannel === newUserChannel) {
    return;
  }
  if (newUserChannel !== null) {
    const channelName = `${slugify(newUserChannel.name, {
      lower: true,
    })}-manibot`;
    const foundChannel = findChannel(newState.guild.channels, channelName);
    if (foundChannel && newUserChannel.parentId === foundChannel.parentId) {
      foundChannel.permissionOverwrites
        .create(newState.member, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        })
        .then((channel) =>
          debug(
            `added "${newState.member.displayName}" to channel "${channel.name}"`,
          ),
        )
        .catch((e) =>
          console.error(
            `failed to add permissions for ${newState.member.displayName}: `,
            e,
          ),
        );
    } else {
      newUserChannel.parent.children
        .create({
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              // Bot
              id: client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              // User that joined the vc
              id: newState.member.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              // @everyone
              id: newState.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
          ],
        })
        .then((channel) => {
          debug(
            `created channel "${channel.name}" for member "${newState.member.displayName}"`,
          );
        })
        .catch((e) =>
          console.error(`failed to create channel ${channelName}: `, e),
        );
    }
  }
  if (oldUserChannel !== null) {
    const channelName = `${slugify(oldUserChannel.name, {
      lower: true,
    })}-manibot`;
    const foundChannel = findChannel(newState.guild.channels, channelName);
    debug("foundChannel: ", foundChannel);
    if (foundChannel && oldUserChannel.parentId === foundChannel.parentId) {
      if (oldUserChannel.members.size === 0) {
        foundChannel
          .delete()
          .then((channel) => debug(`removed channel "${channel.name}"`))
          .catch((e) =>
            console.error(`failed to delete channel ${channelName}: `, e),
          );
      } else {
        foundChannel.permissionOverwrites
          .delete(newState.member)
          .then((channel) =>
            debug(
              `removed "${newState.member.displayName}" from channel "${channel.name}"`,
            ),
          )
          .catch((e) =>
            console.error(
              `failed to remove permissions for ${newState.member.displayName}: `,
              e,
            ),
          );
      }
    }
  }
};
module.exports = { voiceStateUpdateHandler };
