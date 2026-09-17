require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType,
  Collection,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const PREFIX = '!';
const invitesCache = new Collection(); // guildId -> Collection(code -> uses)
const activeGiveaways = new Collection(); // messageId -> { prize, endsAt, hostId, participants: Set }
const warnings = new Collection(); // userId -> count
const MAX_WARNINGS = 3;

const BAD_WORDS = ['badword1', 'badword2']; // add words you want auto-filtered, lowercase only
const spamTracker = new Collection(); // userId -> [timestamps]
const SPAM_LIMIT = 5; // messages
const SPAM_WINDOW_MS = 7000; // within this many ms counts as spam

const seenNewsUrls = new Set();
const NEWS_INTERVAL_MINUTES = parseInt(process.env.NEWS_INTERVAL_MINUTES) || 60;

// ---------- TRADING NEWS AUTO-POST ----------
async function postTradingNews() {
  if (!process.env.NEWS_CHANNEL_ID) return;
  try {
    const res = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
    const data = await res.json();
    const articles = (data.Data || []).slice(0, 5).reverse();

    const channel = client.channels.cache.get(process.env.NEWS_CHANNEL_ID);
    if (!channel) return;

    for (const article of articles) {
      if (seenNewsUrls.has(article.url)) continue;
      seenNewsUrls.add(article.url);

      const embed = new EmbedBuilder()
        .setColor(0x8a3fd9)
        .setTitle(article.title)
        .setURL(article.url)
        .setDescription(article.body ? article.body.slice(0, 200) + '...' : '')
        .setFooter({ text: article.source_info?.name || 'Trading News' })
        .setTimestamp(new Date(article.published_on * 1000));

      await channel.send({ embeds: [embed] }).catch(() => {});
    }

    // keep the seen-list from growing forever
    if (seenNewsUrls.size > 200) {
      const arr = Array.from(seenNewsUrls);
      seenNewsUrls.clear();
      arr.slice(-100).forEach((u) => seenNewsUrls.add(u));
    }
  } catch (e) {
    console.log('News fetch error:', e.message);
  }
}

// ---------- WARNING HELPER ----------
async function issueWarning(member, reason, channel) {
  const current = (warnings.get(member.id) || 0) + 1;
  warnings.set(member.id, current);

  if (current >= MAX_WARNINGS) {
    await channel.send(`⚠️ ${member} has reached ${MAX_WARNINGS}/${MAX_WARNINGS} warnings and has been banned. Reason: ${reason}`);
    await member.ban({ reason: `Reached ${MAX_WARNINGS} warnings: ${reason}` }).catch(() => {});
    warnings.delete(member.id);
  } else {
    await channel.send(`⚠️ ${member} has been warned (${current}/${MAX_WARNINGS}). Reason: ${reason}`);
  }
}

// ---------- READY ----------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    const invites = await guild.invites.fetch().catch(() => new Collection());
    const codeUses = new Collection();
    invites.forEach((inv) => codeUses.set(inv.code, inv.uses));
    invitesCache.set(guild.id, codeUses);
  }

  client.user.setActivity('Bulls & Chill 🐂', { type: 3 }); // Watching

  // start trading news auto-posting
  postTradingNews();
  setInterval(postTradingNews, NEWS_INTERVAL_MINUTES * 60000);
});

// ---------- WELCOME + INVITE TRACKING + AUTO-ROLE ----------
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;

  // auto-assign Member role
  if (process.env.MEMBER_ROLE_ID) {
    await member.roles.add(process.env.MEMBER_ROLE_ID).catch(() => {});
  }

  // figure out who invited them
  let inviterTag = 'unknown';
  try {
    const newInvites = await guild.invites.fetch();
    const oldCodeUses = invitesCache.get(guild.id) || new Collection();
    const used = newInvites.find((inv) => (oldCodeUses.get(inv.code) || 0) < inv.uses);
    if (used) inviterTag = `<@${used.inviter.id}>`;

    const updated = new Collection();
    newInvites.forEach((inv) => updated.set(inv.code, inv.uses));
    invitesCache.set(guild.id, updated);
  } catch (e) {
    console.log('Invite tracking error:', e.message);
  }

  // welcome message
  const welcomeChannel = guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (welcomeChannel) {
    const embed = new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('🐂 A new member has arrived!')
      .setDescription(
        `Welcome ${member}! Glad to have you at Bulls & Chill.\n\nInvited by: ${inviterTag}\n\nPlease head to <#${process.env.VERIFICATION_CHANNEL_ID}> to verify.`
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();
    welcomeChannel.send({ embeds: [embed] }).catch(() => {});
  }
});

client.on('inviteCreate', async (invite) => {
  const codeUses = invitesCache.get(invite.guild.id) || new Collection();
  codeUses.set(invite.code, invite.uses);
  invitesCache.set(invite.guild.id, codeUses);
});

// ---------- BUTTON INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // VERIFY BUTTON
  if (interaction.customId === 'verify_button') {
    const role = interaction.guild.roles.cache.get(process.env.VERIFIED_ROLE_ID);
    if (!role) return interaction.reply({ content: 'Verified role is not set up.', ephemeral: true });

    if (interaction.member.roles.cache.has(role.id)) {
      return interaction.reply({ content: 'You are already verified ✅', ephemeral: true });
    }
    await interaction.member.roles.add(role).catch(() => {});
    return interaction.reply({ content: 'Verified! You can now see all the channels 🎉', ephemeral: true });
  }

  // OPEN TICKET BUTTON
  if (interaction.customId === 'open_ticket') {
    const existing = interaction.guild.channels.cache.find(
      (c) => c.name === `ticket-${interaction.user.username.toLowerCase()}`
    );
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
    }

    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`,
      type: ChannelType.GuildText,
      parent: process.env.TICKET_CATEGORY_ID || null,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ...(process.env.MODERATOR_ROLE_ID
          ? [{ id: process.env.MODERATOR_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }]
          : []),
      ],
    });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: `${interaction.user} your support ticket has been opened. Staff will reply shortly.`,
      components: [closeRow],
    });

    return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  }

  // CLOSE TICKET BUTTON
  if (interaction.customId === 'close_ticket') {
    await interaction.reply('Closing this ticket in 5 seconds...');
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }

  // GIVEAWAY JOIN BUTTON
  if (interaction.customId.startsWith('giveaway_join_')) {
    const messageId = interaction.customId.replace('giveaway_join_', '');
    const giveaway = activeGiveaways.get(messageId);
    if (!giveaway) return interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });

    if (giveaway.participants.has(interaction.user.id)) {
      giveaway.participants.delete(interaction.user.id);
      return interaction.reply({ content: 'Your entry has been removed.', ephemeral: true });
    }
    giveaway.participants.add(interaction.user.id);
    return interaction.reply({ content: 'You are entered! Good luck 🎉', ephemeral: true });
  }
});

// ---------- AUTO-MODERATION (bad words + spam) ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const isModAuthor =
    message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    message.member.roles.cache.has(process.env.MODERATOR_ROLE_ID) ||
    message.member.roles.cache.has(process.env.ADMIN_ROLE_ID);
  if (isModAuthor) return; // never auto-warn staff

  const lower = message.content.toLowerCase();

  // bad word filter
  const hasBadWord = BAD_WORDS.some((w) => w && lower.includes(w));
  if (hasBadWord) {
    await message.delete().catch(() => {});
    await issueWarning(message.member, 'Inappropriate language', message.channel);
    return;
  }

  // spam filter (X messages within Y ms)
  const now = Date.now();
  const timestamps = (spamTracker.get(message.author.id) || []).filter((t) => now - t < SPAM_WINDOW_MS);
  timestamps.push(now);
  spamTracker.set(message.author.id, timestamps);

  if (timestamps.length > SPAM_LIMIT) {
    spamTracker.set(message.author.id, []);
    await issueWarning(message.member, 'Spamming messages', message.channel);
  }
});

// ---------- PREFIX COMMANDS ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const isMod =
    message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    message.member.roles.cache.has(process.env.MODERATOR_ROLE_ID) ||
    message.member.roles.cache.has(process.env.ADMIN_ROLE_ID);

  // ----- !verify-panel (post verify button, admin only) -----
  if (command === 'verify-panel') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
    );
    const embed = new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('Verify to access the server')
      .setDescription('Click the button below to verify and unlock the rest of the channels.');
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  // ----- !ticket-panel (post open ticket button, admin only) -----
  if (command === 'ticket-panel') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Open Ticket').setStyle(ButtonStyle.Primary)
    );
    const embed = new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('Need support?')
      .setDescription('Click the button below to open your own private ticket.');
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  // ----- !giveaway <minutes> <prize> -----
  if (command === 'giveaway') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const minutes = parseInt(args[0]);
    const prize = args.slice(1).join(' ');
    if (!minutes || !prize) return message.reply('Usage: `!giveaway <minutes> <prize name>`');

    const endsAt = Date.now() + minutes * 60000;
    const row = new ActionRowBuilder();

    const embed = new EmbedBuilder()
      .setColor(0xffb020)
      .setTitle('🎉 Giveaway!')
      .setDescription(`**Prize:** ${prize}\n**Ends in:** ${minutes} minute(s)\n\nClick the button below to enter.`)
      .setFooter({ text: `Host: ${message.author.tag}` });

    const sent = await message.channel.send({ embeds: [embed] });
    row.addComponents(
      new ButtonBuilder().setCustomId(`giveaway_join_${sent.id}`).setLabel('🎉 Join').setStyle(ButtonStyle.Success)
    );
    await sent.edit({ embeds: [embed], components: [row] });

    activeGiveaways.set(sent.id, {
      prize,
      endsAt,
      hostId: message.author.id,
      participants: new Set(),
      channelId: message.channel.id,
    });

    setTimeout(async () => {
      const g = activeGiveaways.get(sent.id);
      if (!g) return;
      activeGiveaways.delete(sent.id);
      const channel = client.channels.cache.get(g.channelId);
      const participantsArr = Array.from(g.participants);
      if (participantsArr.length === 0) {
        return channel.send(`The giveaway has ended but nobody entered 🥲 (${g.prize})`);
      }

      const winnerId = participantsArr[Math.floor(Math.random() * participantsArr.length)];

      // 🎡 spin animation — cycle random participants a few times before landing on the winner
      const spinMsg = await channel.send('🎡 Spinning the wheel...');
      const spinRounds = Math.min(8, participantsArr.length * 2);
      for (let i = 0; i < spinRounds; i++) {
        const randomId = participantsArr[Math.floor(Math.random() * participantsArr.length)];
        await spinMsg.edit(`🎡 Spinning... <@${randomId}>`).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
      await spinMsg.edit(`🎡 Landed on... 🎉 <@${winnerId}>!`).catch(() => {});

      channel.send(`🎉 Congrats <@${winnerId}>! You won **${g.prize}**!`);
    }, minutes * 60000);

    return;
  }

  // ----- !invites [@user] -----
  if (command === 'invites') {
    const target = message.mentions.members.first() || message.member;
    const invites = await message.guild.invites.fetch().catch(() => new Collection());
    const total = invites
      .filter((inv) => inv.inviter && inv.inviter.id === target.id)
      .reduce((sum, inv) => sum + inv.uses, 0);
    return message.reply(`${target}'s total invites: **${total}**`);
  }

  // ----- !calendar (economic calendar, this week's high-impact events) -----
  if (command === 'calendar') {
    try {
      const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
      const data = await res.json();

      const highImpact = data
        .filter((ev) => ev.impact === 'High')
        .slice(0, 10);

      if (highImpact.length === 0) {
        return message.channel.send('No high-impact economic events found for this week.');
      }

      const embed = new EmbedBuilder()
        .setColor(0x8a3fd9)
        .setTitle('📅 This Week — High Impact Economic Events')
        .setDescription(
          highImpact
            .map((ev) => `**${ev.title}** (${ev.country})\n${ev.date} ${ev.time || ''}`)
            .join('\n\n')
        );

      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply('Could not fetch the economic calendar right now, try again later.');
    }
  }

  // ----- !warn @user [reason] -----
  if (command === 'warn') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!warn @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await issueWarning(target, reason, message.channel);
    return;
  }

  // ----- !kick @user [reason] -----
  if (command === 'kick') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!kick @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.kick(reason).catch(() => message.reply('Could not kick — check my permissions.'));
    return message.reply(`Kicked ${target.user.tag}. Reason: ${reason}`);
  }

  // ----- !ban @user [reason] -----
  if (command === 'ban') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!ban @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.ban({ reason }).catch(() => message.reply('Could not ban — check my permissions.'));
    return message.reply(`Banned ${target.user.tag}. Reason: ${reason}`);
  }

  // ----- !mute @user <minutes> [reason] -----
  if (command === 'mute') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    const minutes = parseInt(args[1]);
    if (!target || !minutes) return message.reply('Usage: `!mute @user <minutes> [reason]`');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    await target.timeout(minutes * 60000, reason).catch(() => message.reply('Could not mute this member.'));
    return message.reply(`Muted ${target.user.tag} for ${minutes} minute(s).`);
  }

  // ----- !unmute @user -----
  if (command === 'unmute') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!unmute @user`');
    await target.timeout(null).catch(() => {});
    return message.reply(`Removed the mute from ${target.user.tag}.`);
  }

  // ----- !announce <message> (posts to announcements channel) -----
  if (command === 'announce') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const text = args.join(' ');
    if (!text) return message.reply('Usage: `!announce <message>`');
    const channel = message.guild.channels.cache.get(process.env.ANNOUNCEMENTS_CHANNEL_ID);
    if (!channel) return message.reply('Announcements channel ID is not set in the environment variables.');
    const embed = new EmbedBuilder().setColor(0x8a3fd9).setDescription(text).setTimestamp();
    await channel.send({ embeds: [embed] });
    return message.reply('Announcement posted ✅');
  }

  // ----- !help -----
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('🐂 Bull Bot Commands')
      .addFields(
        { name: '!verify-panel', value: 'Posts the verify button (staff)' },
        { name: '!ticket-panel', value: 'Posts the open-ticket button (staff)' },
        { name: '!giveaway <minutes> <prize>', value: 'Starts a giveaway (staff)' },
        { name: '!invites [@user]', value: 'Checks invite count' },
        { name: '!kick @user [reason]', value: 'Kicks a member (staff)' },
        { name: '!ban @user [reason]', value: 'Bans a member (staff)' },
        { name: '!mute @user <minutes> [reason]', value: 'Times out a member (staff)' },
        { name: '!unmute @user', value: 'Removes a timeout (staff)' },
        { name: '!warn @user [reason]', value: 'Warns a member — 3 warnings = auto-ban (staff)' },
        { name: '!calendar', value: 'Shows this week\'s high-impact economic events' },
        { name: '!announce <message>', value: 'Posts to the announcements channel (staff)' }
      );
    return message.channel.send({ embeds: [embed] });
  }
});

client.login(process.env.BOT_TOKEN);
