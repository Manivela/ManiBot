require("dotenv").config();
// const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const { clientId, guildId } = require("../config.json");

const commands = [
  // new SlashCommandBuilder()
  //     .setName('register')
  //     .addStringOption((option => option.setName('address').setDescription('Your ZeroTier address').setRequired(true)))
  //     .setDescription('Authorizes your address on the ZeroTier network'),
].map((command) => command.toJSON());

const rest = new REST({ version: "9" }).setToken(process.env.BOT_TOKEN);

rest
  .put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then(() => console.log("Successfully registered application commands."))
  .catch(console.error);
