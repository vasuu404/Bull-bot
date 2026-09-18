require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('verify-panel').setDescription('Post the verify button (staff only)'),

  new SlashCommandBuilder().setName('ticket-panel').setDescription('Post the open-ticket button (staff only)'),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway (staff only)')
    .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
    .addIntegerOption((opt) => opt.setName('seconds').setDescription('How long entries stay open').setMinValue(1).setRequired(true))
    .addAttachmentOption((opt) => opt.setName('image').setDescription('Optional PNG/image')),

  new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Start a separate spin giveaway (staff only)')
    .addStringOption((opt) => opt.setName('prize').setDescription('What the winner gets').setRequired(true))
    .addIntegerOption((opt) => opt.setName('seconds').setDescription('How long entries stay open').setMinValue(1).setRequired(true))
    .addIntegerOption((opt) => opt.setName('spins').setDescription('Number of shuffle rounds').setMinValue(1).setMaxValue(50).setRequired(true))
    .addAttachmentOption((opt) => opt.setName('image').setDescription('Optional PNG/image')),

  new SlashCommandBuilder().setName('spin-cancel').setDescription('Cancel the active spin giveaway (staff only)'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete the last N messages in this channel (staff only)')
    .addIntegerOption((opt) => opt.setName('amount').setDescription('How many messages (1-100)').setMinValue(1).setMaxValue(100).setRequired(true)),

  new SlashCommandBuilder().setName('clearall').setDescription('Instantly wipe the ENTIRE history of this channel (staff only)'),

  new SlashCommandBuilder()
    .setName('autoclear')
    .setDescription('Automatically wipe a channel on a repeating schedule (staff only)')
    .addIntegerOption((opt) => opt.setName('minutes').setDescription('Clear every this many minutes').setMinValue(1).setRequired(true))
    .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to auto-clear (defaults to this one)')),

  new SlashCommandBuilder()
    .setName('autoclear-stop')
    .setDescription('Stop a channel\'s auto-clear schedule (staff only)')
    .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to stop (defaults to this one)')),

  new SlashCommandBuilder()
    .setName('raid-lockdown')
    .setDescription('Manually toggle anti-raid lockdown mode (staff only)')
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('Turn lockdown on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
    ),

  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Check how many invites a member has')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to check (defaults to you)')),

  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top 10 inviters by real invite count'),

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
    .setName('unban')
    .setDescription('Unban a user by Discord User ID (staff only)')
    .addStringOption((opt) => opt.setName('user').setDescription('Search and select the banned user').setRequired(true).setAutocomplete(true)),

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

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message to any text channel (staff only)')
    .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to send the message in').setRequired(true))
    .addStringOption((opt) => opt.setName('message').setDescription('Message to send').setRequired(true)),

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
