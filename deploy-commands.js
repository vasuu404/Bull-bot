require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('verify-panel').setDescription('Post the verify button (staff only)'),

  new SlashCommandBuilder().setName('ticket-panel').setDescription('Post the open-ticket button (staff only)'),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway (staff only)')
    .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
    .addIntegerOption((opt) => opt.setName('seconds').setDescription('How long entries stay open (default 15)')),

  new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Spin the wheel now among current giveaway entries (staff only)'),

  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Check how many invites a member has')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to check (defaults to you)')),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout a member (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to mute').setRequired(true))
    .addIntegerOption((opt) => opt.setName('minutes').setDescription('Duration in minutes').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Remove a timeout from a member (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to unmute').setRequired(true)),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member — 3 warnings auto-bans (staff only)')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason')),

  new SlashCommandBuilder().setName('calendar').setDescription('Show this week\'s high-impact economic events'),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post a message to the announcements channel (staff only)')
    .addStringOption((opt) => opt.setName('message').setDescription('The announcement text').setRequired(true)),

  new SlashCommandBuilder().setName('help').setDescription('Show all Bull bot commands'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.APPLICATION_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully! They should show up instantly in your server.');
  } catch (error) {
    console.error(error);
  }
})();
