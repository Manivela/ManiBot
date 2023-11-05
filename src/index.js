require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { presenceUpdateHandler } = require("./handlers/presenceUpdate");
const { voiceStateUpdateHandler } = require("./handlers/voiceStateUpdate");
const debug = require("debug")("main");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("ready", async () => {
  await Promise.all(
    client.guilds.cache.map(async (g) => {
      return g.roles
        .fetch()
        .then((roles) => debug(`fetched ${roles.size} roles for ${g.name}`));
    })
  );
  console.log("------------Bot is ready------------");
});

client.on("messageCreate", (msg) => {
  if (msg.content === "ping") {
    msg.channel.send("pong");
  }
});

client.on("presenceUpdate", presenceUpdateHandler);

client.on("voiceStateUpdate", (oldState, newState) =>
  voiceStateUpdateHandler(oldState, newState, client)
);

client.login(process.env.BOT_TOKEN);
