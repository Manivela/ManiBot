const { ChannelType } = require("discord.js");
const debug = require("debug")("utils:channel");

function findChannel(serverChannels, channelName) {
  if (!channelName) {
    debug("No channel name provided");
    return null;
  }

  return serverChannels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText && channel.name === channelName
  );
}

module.exports = { findChannel };
