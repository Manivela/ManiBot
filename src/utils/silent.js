const { MessageFlags } = require("discord.js");

// Bot messages show up without pushing a notification to anyone.
const silent = (payload) => ({
  ...(typeof payload === "string" ? { content: payload } : payload),
  flags: MessageFlags.SuppressNotifications,
});

module.exports = { silent };
