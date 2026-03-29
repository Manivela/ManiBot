require("dotenv").config();
const dns = require("node:dns");
const { Client, GatewayIntentBits } = require("discord.js");
const { presenceUpdateHandler } = require("./handlers/presenceUpdate");
const { createMessageCreateHandler } = require("./handlers/messageCreate");
// const { voiceStateUpdateHandler } = require("./handlers/voiceStateUpdate");
const debug = require("debug")("main");
const voiceGatewayDebug = require("debug")("voiceGateway");
const Sentry = require("@sentry/node");
const musicPlayer = require("./music/player");
const { startYtDlpScheduledUpdates } = require("./music/ytDlpScheduler");

dns.setDefaultResultOrder("ipv4first");

startYtDlpScheduledUpdates();

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

client.on("clientReady", async () => {
  await Promise.all(
    client.guilds.cache.map(async (g) => {
      return g.roles
        .fetch()
        .then((roles) => debug(`fetched ${roles.size} roles for ${g.name}`));
    }),
  );
  console.log("------------Bot is ready------------");
});

client.on("messageCreate", createMessageCreateHandler({ musicPlayer }));

client.on("presenceUpdate", presenceUpdateHandler);

client.on("raw", (packet) => {
  if (packet.t !== "VOICE_SERVER_UPDATE" && packet.t !== "VOICE_STATE_UPDATE") {
    return;
  }

  const data = packet.d || {};
  voiceGatewayDebug(
    `${packet.t} guild=${data.guild_id || "unknown"} channel=${data.channel_id || "null"} user=${data.user_id || "unknown"} session=${data.session_id ? "present" : "missing"}`,
  );
});

// client.on("voiceStateUpdate", (oldState, newState) => {
//   voiceStateUpdateHandler(oldState, newState, client);
// });

client.login(process.env.BOT_TOKEN);
