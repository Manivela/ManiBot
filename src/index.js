require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { presenceUpdateHandler } = require("./handlers/presenceUpdate");
const { voiceStateUpdateHandler } = require("./handlers/voiceStateUpdate");
const testCommand = require("./commands/test");
const debug = require("debug")("main");
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  beforeSend: (event, hint) => {
    if (process.env.NODE_ENV !== "production") {
      const errorMessage = event.breadcrumbs.at(-1)?.message || "";
      console.error(errorMessage, hint.originalException);
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

const prefix = "!";

client.on("messageCreate", (msg) => {
  if (msg.content === "ping") {
    msg.channel.send("pong");
    return;
  }

  if (!msg.content.startsWith(prefix) || msg.author.bot) return;

  const args = msg.content.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  if (commandName === "test") {
    testCommand.execute(msg, args, client);
  }
});

client.on("presenceUpdate", presenceUpdateHandler);

client.on("voiceStateUpdate", (oldState, newState) => {
  voiceStateUpdateHandler(oldState, newState, client);
});

client.login(process.env.BOT_TOKEN);
