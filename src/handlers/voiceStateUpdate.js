const { default: slugify } = require("slugify");
const { findChannel } = require("../utils/channel");
const { PermissionFlagsBits, ChannelType } = require("discord.js");

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
          VIEW_CHANNEL: true,
          SEND_MESSAGES: true,
          READ_MESSAGE_HISTORY: true,
        })
        .then((channel) =>
          console.log(
            `added "${newState.member.displayName}" to channel "${channel.name}"`
          )
        )
        .catch((e) =>
          console.log(
            `failed to add permissions for ${newState.member.displayName}: `,
            e
          )
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
          console.log(
            `created channel "${channel.name}" for member "${newState.member.displayName}"`
          );
        })
        .catch((e) =>
          console.log(`failed to create channel ${channelName}: `, e)
        );
    }
  }
  if (oldUserChannel !== null) {
    const channelName = `${slugify(oldUserChannel.name, {
      lower: true,
    })}-manibot`;
    const foundChannel = findChannel(newState.guild.channels, channelName);
    console.log("foundChannel: ", foundChannel);
    if (foundChannel && oldUserChannel.parentId === foundChannel.parentId) {
      if (oldUserChannel.members.size === 0) {
        foundChannel
          .delete()
          .then((channel) => console.log(`removed channel "${channel.name}"`))
          .catch((e) =>
            console.log(`failed to delete channel ${channelName}: `, e)
          );
      }

      foundChannel.permissionOverwrites
        .delete(newState.member)
        .then((channel) =>
          console.log(
            `removed "${newState.member.displayName}" from channel "${channel.name}"`
          )
        )
        .catch((e) =>
          console.log(
            `failed to remove permissions for ${newState.member.displayName}: `,
            e
          )
        );
    }
  }
};
module.exports = { voiceStateUpdateHandler };
