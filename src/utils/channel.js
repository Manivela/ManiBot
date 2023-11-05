const { ChannelType } = require("discord.js");

function findChannel(serverChannels, channelName) {
  return serverChannels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText && channel.name === channelName
  );
}
module.exports = { findChannel };
