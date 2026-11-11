require("./instrument");
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

// Sentry opens an issue, and emails, when these check-ins stop: host off,
// Docker down, or Discord lost. Not on Fly, which is stopped every night.
const HEARTBEAT_MINUTES = 5;
const heartbeat = () => {
  if (client.isReady()) {
    Sentry.captureCheckIn(
      { monitorSlug: "manibot", status: "ok" },
      {
        schedule: {
          type: "interval",
          value: HEARTBEAT_MINUTES,
          unit: "minute",
        },
        checkinMargin: HEARTBEAT_MINUTES,
        failureIssueThreshold: 2, // so a deploy's restart doesn't alert
        recoveryThreshold: 1,
      },
    );
  }
};
if (!process.env.FLY_APP_NAME) {
  client.once("clientReady", heartbeat);
  setInterval(heartbeat, HEARTBEAT_MINUTES * 60_000);
}

// A trace per message; otherwise the whole process shares one.
const handleMessage = createMessageCreateHandler({ musicPlayer });
client.on("messageCreate", (msg) =>
  Sentry.startNewTrace(() => handleMessage(msg)),
);

// Keeps the member this handler sets as the Sentry user out of other events.
client.on("presenceUpdate", (...args) =>
  Sentry.withIsolationScope(() => presenceUpdateHandler(...args)),
);

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

// Load persisted volume preferences before serving commands. hydrate never
// rejects, but log-in proceeds regardless so storage issues can't block boot.
musicPlayer
  .hydratePreferredVolumes()
  .catch((error) => debug("failed to hydrate volume preferences", error))
  .finally(() => client.login(process.env.BOT_TOKEN));
