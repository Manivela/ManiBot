// Tells each guild's bot channel (`!botchannel`) when the bot comes up on a
// commit it hasn't announced there yet. A restart on the same commit says
// nothing.
const Sentry = require("@sentry/node");
const debug = require("debug")("deployNotice");
const store = require("./games/store");
const upstash = require("./utils/upstash");
const { silent } = require("./utils/silent");

const REPO_URL = "https://github.com/Manivela/ManiBot";

const announceDeploy = async (client) => {
  const sha = process.env.GIT_SHA;
  // No commit (a local run) or nowhere to remember it (every restart would
  // announce again).
  if (!sha || !upstash.isEnabled()) {
    return;
  }
  const release = process.env.RELEASE_VERSION;
  for (const guild of client.guilds.cache.values()) {
    try {
      const state = await store.getGuildState(guild.id);
      const previous = state.config.announcedSha;
      const channel = guild.channels.cache.get(state.config.botChannelId);
      if (previous === sha || !channel) {
        continue;
      }
      const changes = previous
        ? `[what changed](<${REPO_URL}/compare/${previous}...${sha}>)`
        : `[commit](<${REPO_URL}/commit/${sha}>)`;
      await channel.send(
        silent(
          `🚀 New version deployed: \`${sha.slice(0, 7)}\`${release ? ` (${release})` : ""}, ${changes}`,
        ),
      );
      store.setConfig(guild.id, state, { announcedSha: sha });
    } catch (error) {
      debug("failed to announce the deploy in guild %s", guild.id, error);
      Sentry.captureException(error);
    }
  }
};

module.exports = { announceDeploy };
