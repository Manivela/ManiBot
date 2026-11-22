const { MessageFlags } = require("discord.js");
const { handleRolesInteraction } = require("../games/picker");
const { handleGameInteraction } = require("../games/proposals");

// The #roles picker, game proposals, and the buttons under each "Now playing"
// message (player.js buildControls).
const createInteractionCreateHandler =
  ({ musicPlayer }) =>
  async (interaction) => {
    if (interaction.customId?.startsWith("roles:")) {
      await handleRolesInteraction(interaction);
      return;
    }
    if (interaction.customId?.startsWith("game:")) {
      await handleGameInteraction(interaction);
      return;
    }
    if (!interaction.isButton() || !interaction.customId.startsWith("music:")) {
      return;
    }

    const { guildId } = interaction;
    // A past song's, or from before a restart: drop them, don't act on them.
    if (!musicPlayer.isCurrentControls(guildId, interaction.message.id)) {
      await interaction.update({ components: [] });
      return;
    }

    const queue = musicPlayer.getQueue(guildId);
    if (interaction.member?.voice?.channelId !== queue.voiceChannelId) {
      await interaction.reply({
        content: "Join the bot's voice channel to use these.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const by = interaction.user.username;
    try {
      switch (interaction.customId) {
        case "music:pause":
          musicPlayer.togglePause(guildId);
          break;
        case "music:skip":
          musicPlayer.skip(guildId, by);
          break;
        case "music:stop":
          musicPlayer.stop(guildId, by);
          break;
        case "music:autoplay":
          musicPlayer.toggleAutoplay(guildId);
          break;
        default:
          break;
      }
    } catch (error) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // The player edits the message itself; this just acknowledges the press.
    await interaction.deferUpdate();
  };

module.exports = { createInteractionCreateHandler };
