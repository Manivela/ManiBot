require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { presenceUpdateHandler } = require("./handlers/presenceUpdate");
const { voiceStateUpdateHandler } = require("./handlers/voiceStateUpdate");
const debug = require("debug")("main");
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend: (event, hint) => {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        event.breadcrumbs.at(-1).message || "",
        hint.originalException,
      );
      return;
    }
    return event;
  },
});

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
    }),
  );
  console.log("------------Bot is ready------------");
});

client.on("messageCreate", (msg) => {
  if (msg.content === "ping") {
    msg.channel.send("pong");
  }
});

client.on("presenceUpdate", presenceUpdateHandler);

client.on("voiceStateUpdate", (oldState, newState) => {
  voiceStateUpdateHandler(oldState, newState, client);
});

client.login(process.env.BOT_TOKEN);
