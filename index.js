require('dotenv').config()
const { Client, Intents } = require('discord.js')
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES] });

client.login(process.env.BOT_TOKEN)
client.on("ready", () => {
    console.log("Bot is ready")
})
client.on("messageCreate", msg => {
    if (msg.content === "marco") {
        msg.channel.send("polo")
    }
})