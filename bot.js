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
const warnings = new Collection(); // userId -> count
const MAX_WARNINGS = 3;

const BAD_WORDS = ['badword1', 'badword2']; // add words you want auto-filtered, lowercase only
const spamTracker = new Collection(); // userId -> [timestamps]
const SPAM_LIMIT = 5;
const SPAM_WINDOW_MS = 7000;

const seenNewsUrls = new Set();
const NEWS_INTERVAL_MINUTES = 15;
const FOREX_NEWS_FEED_URL =
  process.env.FOREX_NEWS_FEED_URL || 'https://www.investing.com/rss/news_285.rss';
const newJoiners = new Set(); // only members who joined while this bot process is running
const calendarPostedWeeks = new Set();

// =========================================================
// NORMAL GIVEAWAY (independent, plain winner announcement)
// =========================================================
let normalGiveaway = null; // { prize, imageUrl, participants: Set, channelId, timeoutHandle }

async function startNormalGiveaway(channel, prize, seconds, imageUrl) {
  if (normalGiveaway) {
    return channel.send('A normal giveaway is already running — wait for it to finish first.');
  }

  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle('🎉 Giveaway!')
    .setDescription(`**Prize:** ${prize}\n**Entries close in:** ${seconds} second(s)\n\nClick the button below to enter!`);
  if (imageUrl) embed.setImage(imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('giveaway_join').setLabel('🎉 Join').setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });

  normalGiveaway = { prize, imageUrl, participants: new Set(), channelId: channel.id };
  normalGiveaway.timeoutHandle = setTimeout(() => endNormalGiveaway(channel), seconds * 1000);
}

async function endNormalGiveaway(channel) {
  if (!normalGiveaway) return;
  const { prize, participants } = normalGiveaway;
  normalGiveaway = null;

  const pool = Array.from(participants);
  if (pool.length === 0) {
    return channel.send(`The giveaway for **${prize}** ended but nobody entered 🥲`);
  }
  const winnerId = pool[Math.floor(Math.random() * pool.length)];
  return channel.send(`🎉 Congrats <@${winnerId}>! You won **${prize}**!`);
}

// =========================================================
// SPIN SYSTEM (fully separate — countdown, entries, shuffle,
// claim with 1-min timer, auto-restart loop on decline/timeout)
// =========================================================
let spinConfig = null; // { prize, entrySeconds, spinRounds, imageUrl, channelId, active, remainingSpins }
let spinParticipants = new Set();
let spinClaim = null; // { winnerId, resolved, timeoutHandle, claimMsg }
let spinEntryTimeoutHandle = null;

async function stopSpin(channel) {
  spinConfig = null;
  spinParticipants = new Set();
  if (spinClaim && spinClaim.timeoutHandle) clearTimeout(spinClaim.timeoutHandle);
  spinClaim = null;
  if (spinEntryTimeoutHandle) clearTimeout(spinEntryTimeoutHandle);
  spinEntryTimeoutHandle = null;
  if (channel) await channel.send('🛑 Spin giveaway cancelled.').catch(() => {});
}

async function startSpinFlow(channel, prize, entrySeconds, spinRounds, imageUrl) {
  if (spinConfig && spinConfig.active) {
    return channel.send('A spin giveaway is already running — use `/spin-cancel` to stop it first.');
  }
  spinConfig = {
    prize, entrySeconds, spinRounds, imageUrl, channelId: channel.id, active: true,
    remainingSpins: Math.max(1, spinRounds || 1),
  };
  spinParticipants = new Set();
  await beginSpinCountdown(channel);
}

async function beginSpinCountdown(channel) {
  if (!spinConfig || !spinConfig.active) return;

  // @here is intentionally used only for spin-giveaway announcements.
  await channel.send({
    content: `@here 🎰 **${spinConfig.prize}** spin giveaway is about to start!`,
    allowedMentions: { parse: ['everyone'] },
  });

  // Separate messages so 3 -> 2 -> 1 are not edits.
  await channel.send({
    content: '@here 🚨 **SPIN WILL START IN**',
    allowedMentions: { parse: ['everyone'] },
  });
  await channel.send('**3**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send('**2**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send('**1**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send({
    content: '@here 🚨 **ENTER FAST!**',
    allowedMentions: { parse: ['everyone'] },
  });

  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle('🎰 Spin Giveaway!')
    .setDescription(
      `**Prize:** ${spinConfig.prize}\n**Spins remaining:** ${spinConfig.remainingSpins}\n**Entries close in:** ${spinConfig.entrySeconds} second(s)\n\nClick the button below to enter!`
    );
  if (spinConfig.imageUrl) embed.setImage(spinConfig.imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('spin_join').setLabel('🎉 Join').setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
  spinEntryTimeoutHandle = setTimeout(() => runSpinShuffle(channel), spinConfig.entrySeconds * 1000);
}

const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣', '⭐', '💰', '🎯'];
const SLOT_BLUR_SYMBOLS = ['🌫️', '💨', '✨', '⚡', '🌀', '💫', '🔄', '🌪️', '🎆'];

function shuffle3x3(pool, blurred = false) {
  return Array.from({ length: 9 }, () => ({
    id: pool[Math.floor(Math.random() * pool.length)],
    symbol: (blurred ? SLOT_BLUR_SYMBOLS : SLOT_SYMBOLS)[Math.floor(Math.random() * (blurred ? SLOT_BLUR_SYMBOLS : SLOT_SYMBOLS).length)],
  }));
}

function renderSlotGrid(cells, guild) {
  const rows = [0, 1, 2].map((row) => {
    const rowCells = cells.slice(row * 3, row * 3 + 3).map(({ id, symbol }) => {
      const member = guild.members.cache.get(id);
      const name = member ? (member.displayName || member.user.username) : 'USER';
      return `${symbol} ${name.replace(/@/g, '').slice(0, 9)}`;
    });
    return `│ ${rowCells[0].padEnd(13)} │ ${rowCells[1].padEnd(13)} │ ${rowCells[2].padEnd(13)} │`;
  });

  return [
    '```text',
    '╔═══════════════╦═══════════════╦═══════════════╗',
    rows[0],
    '╠═══════════════╬═══════════════╬═══════════════╣',
    rows[1],
    '╠═══════════════╬═══════════════╬═══════════════╣',
    rows[2],
    '╚═══════════════╩═══════════════╩═══════════════╝',
    '```',
  ].join('\n');
}

function winnerSlotGrid(winnerId, guild) {
  return renderSlotGrid(
    Array.from({ length: 9 }, (_, i) => ({ id: winnerId, symbol: SLOT_SYMBOLS[i % SLOT_SYMBOLS.length] })),
    guild
  );
}

async function runSpinShuffle(channel) {
  if (!spinConfig || !spinConfig.active) return;

  const pool = Array.from(spinParticipants);
  if (pool.length === 0) {
    await channel.send(`⚠️ No entries for **${spinConfig.prize}**. Spin giveaway cancelled.`);
    spinConfig = null;
    return;
  }

  const winnerId = pool[Math.floor(Math.random() * pool.length)];
  const rounds = Math.max(10, Math.min(16, spinConfig.spinRounds || 10));

  const slotMsg = await channel.send({
    content: `🎰 **SPINNING...** 💨✨\n${renderSlotGrid(shuffle3x3(pool, true), channel.guild)}`,
  });

  for (let i = 0; i < rounds; i++) {
    await slotMsg.edit({
      content: `🎰 **SPINNING...** ${i % 2 ? '💨✨' : '🌀⚡'}\n${renderSlotGrid(shuffle3x3(pool, true), channel.guild)}`,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
  }

  await slotMsg.edit({
    content: `🎯 **RESULT!** 🎉\n${winnerSlotGrid(winnerId, channel.guild)}`,
  }).catch(() => {});

  const claimRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('claim_open').setLabel('🎫 Open Ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('claim_noopen').setLabel('🔄 Respin').setStyle(ButtonStyle.Danger)
  );

  const claimEmbed = new EmbedBuilder()
    .setColor(0x3fb950)
    .setTitle('🎉 You won!')
    .setDescription(
      `<@${winnerId}> you won **${spinConfig.prize}**!\n\nClick **🎫 Open Ticket** to claim your prize. You have **1 minute** to respond. If you choose **🔄 Respin** or do not respond, the **same entries will be used again** — nobody needs to enter again.`
    );

  const claimMsg = await channel.send({ content: `<@${winnerId}>`, embeds: [claimEmbed], components: [claimRow] });
  spinClaim = { winnerId, resolved: false, claimMsg };
  spinClaim.timeoutHandle = setTimeout(async () => {
    if (spinClaim && !spinClaim.resolved) {
      spinClaim.resolved = true;
      await claimMsg.edit({ components: [] }).catch(() => {});
      await channel.send('⏱️ **No response.** 🔄 Respinning with the **same entries**...');
      spinClaim = null;
      // IMPORTANT: preserve spinParticipants on a respin.
      await runSpinShuffle(channel);
    }
  }, 60000);
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

// ---------- TICKET CREATION HELPER ----------
async function createTicketChannel(guild, user, { namePrefix = 'ticket', openingMessage }) {
  const safeName = `${namePrefix}-${user.username}`.toLowerCase().slice(0, 90);
  const existing = guild.channels.cache.find((c) => c.name === safeName);
  if (existing) return { channel: existing, alreadyExisted: true };

  const channel = await guild.channels.create({
    name: safeName,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID || null,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ...(process.env.MODERATOR_ROLE_ID
        ? [{ id: process.env.MODERATOR_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }]
        : []),
    ],
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: openingMessage, components: [closeRow] });
  return { channel, alreadyExisted: false };
}

// ---------- TRADING NEWS AUTO-POST ----------
function decodeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(text) {
  return decodeXml(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssItems(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => {
    const item = m[1];
    const get = (tag) => {
      const match = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return match ? decodeXml(match[1]).trim() : '';
    };

    return {
      title: stripHtml(get('title')),
      link: stripHtml(get('link')),
      description: stripHtml(get('description')),
      pubDate: get('pubDate'),
    };
  }).filter((x) => x.title && x.link);
}

async function postTradingNews() {
  if (!process.env.NEWS_CHANNEL_ID) return;

  try {
    const res = await fetch(FOREX_NEWS_FEED_URL, {
      headers: { 'User-Agent': 'BullBot/1.0 (Forex community news reader)' },
    });
    if (!res.ok) throw new Error(`News HTTP ${res.status}`);

    const xml = await res.text();
    const articles = parseRssItems(xml).slice(0, 10);
    const channel = client.channels.cache.get(process.env.NEWS_CHANNEL_ID);
    if (!channel) return;

    let posted = 0;
    for (const article of articles.reverse()) {
      const key = article.link || article.title;
      if (seenNewsUrls.has(key)) continue;

      const embed = new EmbedBuilder()
        .setColor(0x8a3fd9)
        .setTitle(`💱 ${article.title}`)
        .setURL(article.link)
        .setDescription(article.description ? article.description.slice(0, 500) : 'Latest forex/trading market news.')
        .setFooter({ text: 'Forex News • Bull Bot' })
        .setTimestamp(article.pubDate ? new Date(article.pubDate) : new Date());

      // IMPORTANT: no @here / @everyone / member mention in news posts.
      await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      }).catch(() => {});

      seenNewsUrls.add(key);
      posted++;
    }

    if (seenNewsUrls.size > 300) {
      const arr = Array.from(seenNewsUrls);
      seenNewsUrls.clear();
      arr.slice(-150).forEach((u) => seenNewsUrls.add(u));
    }

    if (posted) console.log(`Posted ${posted} forex news item(s).`);
  } catch (e) {
    console.log('Forex news fetch error:', e.message);
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

  client.user.setActivity('Bulls & Chill 🐂', { type: 3 });

  postTradingNews();
  setInterval(postTradingNews, NEWS_INTERVAL_MINUTES * 60000);

  // Weekly economic calendar: post once per ISO week.
  postWeeklyEconomicCalendar();
  setInterval(postWeeklyEconomicCalendar, 60 * 60 * 1000);
});

// ---------- WELCOME + INVITE TRACKING + AUTO-ROLE ----------
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  newJoiners.add(member.id);

  if (process.env.MEMBER_ROLE_ID) {
    await member.roles.add(process.env.MEMBER_ROLE_ID).catch(() => {});
  }

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

// ---------- SHARED HELPERS ----------
function isStaffMember(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.roles.cache.has(process.env.MODERATOR_ROLE_ID) ||
    member.roles.cache.has(process.env.ADMIN_ROLE_ID)
  );
}

async function handleVerifyPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
  );
  const embed = new EmbedBuilder()
    .setColor(0x8a3fd9)
    .setTitle('Verify to access the server')
    .setDescription('Click the button below to verify and unlock the rest of the channels.');
  await channel.send({ embeds: [embed], components: [row] });
}

async function handleTicketPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Open Ticket').setStyle(ButtonStyle.Primary)
  );
  const embed = new EmbedBuilder()
    .setColor(0x8a3fd9)
    .setTitle('Need support?')
    .setDescription('Click the button below to open your own private ticket.');
  await channel.send({ embeds: [embed], components: [row] });
}

async function handleInvitesCheck(guild, targetUser) {
  const invites = await guild.invites.fetch().catch(() => new Collection());
  const total = invites
    .filter((inv) => inv.inviter && inv.inviter.id === targetUser.id)
    .reduce((sum, inv) => sum + inv.uses, 0);
  return total;
}

function parseCalendarDateTime(ev) {
  if (!ev || !ev.date) return null;

  const dateText = String(ev.date).trim();
  const timeText = String(ev.time || '12:00am').trim();

  // Forex Factory's calendar feed is treated as UTC here.
  // We explicitly append UTC so the displayed conversion is deterministic.
  const iso = `${dateText} ${timeText} UTC`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatUtcIst(date) {
  const utc = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return `${utc} UTC (${ist} IST)`;
}

async function fetchCalendarEvents() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
  return res.json();
}

async function handleCalendar() {
  const data = await fetchCalendarEvents();
  const highImpact = data
    .filter((ev) => ev.impact === 'High')
    .map((ev) => ({ ...ev, parsedDate: parseCalendarDateTime(ev) }))
    .sort((a, b) => (a.parsedDate || 0) - (b.parsedDate || 0))
    .slice(0, 12);

  if (highImpact.length === 0) {
    return new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('📅 This Week — High Impact Economic Events')
      .setDescription('No high-impact events found for this week.');
  }

  return new EmbedBuilder()
    .setColor(0x8a3fd9)
    .setTitle('📅 This Week — High Impact Economic Events')
    .setDescription(
      highImpact.map((ev) => {
        const when = ev.parsedDate
          ? formatUtcIst(ev.parsedDate)
          : `${ev.date} ${ev.time || ''} UTC`;
        return `**${ev.title}** (${ev.country})\n🕒 ${when}`;
      }).join('\n\n')
    )
    .setFooter({ text: 'Times shown in UTC with Indian Standard Time (IST) in parentheses.' });
}

function currentIsoWeekKey() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function postWeeklyEconomicCalendar() {
  if (!process.env.ECONOMIC_CALENDAR_CHANNEL_ID) return;

  const weekKey = currentIsoWeekKey();
  if (calendarPostedWeeks.has(weekKey)) return;

  try {
    const channel = client.channels.cache.get(process.env.ECONOMIC_CALENDAR_CHANNEL_ID);
    if (!channel) return;

    const embed = await handleCalendar();
    await channel.send({ embeds: [embed] });
    calendarPostedWeeks.add(weekKey);
  } catch (e) {
    console.log('Economic calendar error:', e.message);
  }
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x8a3fd9)
    .setTitle('🐂 Bull Bot Commands')
    .setDescription('All commands start with `/` — type `/` in any channel to see the full list pop up.')
    .addFields(
      { name: '/verify-panel', value: 'Posts the verify button (staff)' },
      { name: '/ticket-panel', value: 'Posts the open-ticket button (staff)' },
      { name: '/giveaway <prize> [seconds] [image]', value: 'Simple giveaway — plain winner announcement (staff)' },
      { name: '/spin <prize> [seconds] [spins] [image]', value: 'Full spin giveaway with countdown, slot-style shuffle, and prize claim (staff)' },
      { name: '/spin-cancel', value: 'Stops an active spin giveaway loop (staff)' },
      { name: '/invites [user]', value: 'Checks invite count' },
      { name: '/kick <user> [reason]', value: 'Kicks a member (staff)' },
      { name: '/ban <user> [reason]', value: 'Bans a member (staff)' },
      { name: '/mute <user> <minutes> [reason]', value: 'Times out a member (staff)' },
      { name: '/unmute <user>', value: 'Removes a timeout (staff)' },
      { name: '/warn <user> [reason]', value: 'Warns a member — 3 warnings = auto-ban (staff)' },
      { name: '/calendar', value: 'Shows this week\'s high-impact economic events with UTC + IST times' },
      { name: '/announce <message>', value: 'Posts to the announcements channel (staff)' }
    );
}

// ---------- SLASH COMMANDS ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guild, channel } = interaction;
  const isMod = isStaffMember(member);

  if (commandName === 'verify-panel') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    await handleVerifyPanel(channel);
    return interaction.reply({ content: 'Verify panel posted ✅', ephemeral: true });
  }

  if (commandName === 'ticket-panel') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    await handleTicketPanel(channel);
    return interaction.reply({ content: 'Ticket panel posted ✅', ephemeral: true });
  }

  if (commandName === 'giveaway') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const prize = interaction.options.getString('prize');
    const seconds = interaction.options.getInteger('seconds') || 15;
    const image = interaction.options.getAttachment('image');
    await interaction.reply({ content: 'Giveaway started ✅', ephemeral: true });
    await startNormalGiveaway(channel, prize, seconds, image ? image.url : null);
    return;
  }

  if (commandName === 'spin') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const prize = interaction.options.getString('prize');
    const seconds = interaction.options.getInteger('seconds') || 15;
    const spins = interaction.options.getInteger('spins') || 8;
    const image = interaction.options.getAttachment('image');
    await interaction.reply({ content: 'Spin giveaway started ✅', ephemeral: true });
    await startSpinFlow(channel, prize, seconds, spins, image ? image.url : null);
    return;
  }

  if (commandName === 'spin-cancel') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    await interaction.reply({ content: 'Spin giveaway cancelled ✅', ephemeral: true });
    await stopSpin(channel);
    return;
  }

  if (commandName === 'invites') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const total = await handleInvitesCheck(guild, targetUser);
    return interaction.reply(`${targetUser} has **${total}** total invites.`);
  }

  if (commandName === 'kick') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) return interaction.reply({ content: 'Could not find that member.', ephemeral: true });
    await targetMember.kick(reason).catch(() => {});
    return interaction.reply(`Kicked ${targetUser.tag}. Reason: ${reason}`);
  }

  if (commandName === 'ban') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    await guild.members.ban(targetUser.id, { reason }).catch(() => {});
    return interaction.reply(`Banned ${targetUser.tag}. Reason: ${reason}`);
  }

  if (commandName === 'mute') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) return interaction.reply({ content: 'Could not find that member.', ephemeral: true });
    await targetMember.timeout(minutes * 60000, reason).catch(() => {});
    return interaction.reply(`Muted ${targetUser.tag} for ${minutes} minute(s).`);
  }

  if (commandName === 'unmute') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) return interaction.reply({ content: 'Could not find that member.', ephemeral: true });
    await targetMember.timeout(null).catch(() => {});
    return interaction.reply(`Removed the mute from ${targetUser.tag}.`);
  }

  if (commandName === 'warn') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) return interaction.reply({ content: 'Could not find that member.', ephemeral: true });
    await interaction.reply({ content: 'Warning issued.', ephemeral: true });
    await issueWarning(targetMember, reason, channel);
    return;
  }

  if (commandName === 'calendar') {
    await interaction.deferReply();
    try {
      const embed = await handleCalendar();
      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      return interaction.editReply('Could not fetch the economic calendar right now, try again later.');
    }
  }

  if (commandName === 'announce') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const text = interaction.options.getString('message');
    const announceChannel = guild.channels.cache.get(process.env.ANNOUNCEMENTS_CHANNEL_ID);
    if (!announceChannel) return interaction.reply({ content: 'Announcements channel ID is not set.', ephemeral: true });
    const embed = new EmbedBuilder().setColor(0x8a3fd9).setDescription(text).setTimestamp();
    await announceChannel.send({ embeds: [embed] });
    return interaction.reply({ content: 'Announcement posted ✅', ephemeral: true });
  }

  if (commandName === 'help') {
    return interaction.reply({ embeds: [buildHelpEmbed()] });
  }
});

// ---------- BUTTON INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'verify_button') {
    const role = interaction.guild.roles.cache.get(process.env.VERIFIED_ROLE_ID);
    if (!role) return interaction.reply({ content: 'Verified role is not set up.', ephemeral: true });
    if (interaction.member.roles.cache.has(role.id)) {
      return interaction.reply({ content: 'You are already verified ✅', ephemeral: true });
    }
    await interaction.member.roles.add(role).catch(() => {});

    // Only members who joined while this bot was running get the post-verification Rules mention.
    if (newJoiners.has(interaction.user.id)) {
      const rulesChannel = interaction.guild.channels.cache.get(process.env.RULES_CHANNEL_ID);
      if (rulesChannel) {
        await rulesChannel.send({
          content: `${interaction.user} ✅ Welcome! You are verified. Please read the rules above before chatting.`,
          allowedMentions: { users: [interaction.user.id] },
        }).catch(() => {});
      }
      newJoiners.delete(interaction.user.id);
    }

    return interaction.reply({ content: 'Verified! You can now see all the channels 🎉', ephemeral: true });
  }

  if (interaction.customId === 'open_ticket') {
    const { channel, alreadyExisted } = await createTicketChannel(interaction.guild, interaction.user, {
      namePrefix: 'ticket',
      openingMessage: `${interaction.user} your support ticket has been opened. Staff will reply shortly.`,
    });
    if (alreadyExisted) {
      return interaction.reply({ content: `You already have an open ticket: ${channel}`, ephemeral: true });
    }
    return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  }

  if (interaction.customId === 'close_ticket') {
    await interaction.reply('Closing this ticket in 5 seconds...');
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  // NORMAL GIVEAWAY JOIN
  if (interaction.customId === 'giveaway_join') {
    if (!normalGiveaway) {
      return interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });
    }
    if (normalGiveaway.participants.has(interaction.user.id)) {
      normalGiveaway.participants.delete(interaction.user.id);
      return interaction.reply({ content: 'Your entry has been removed.', ephemeral: true });
    }
    normalGiveaway.participants.add(interaction.user.id);
    return interaction.reply({ content: 'You are entered! Good luck 🎉', ephemeral: true });
  }

  // SPIN GIVEAWAY JOIN
  if (interaction.customId === 'spin_join') {
    if (!spinConfig || !spinConfig.active) {
      return interaction.reply({ content: 'This spin giveaway is no longer active.', ephemeral: true });
    }
    if (spinParticipants.has(interaction.user.id)) {
      spinParticipants.delete(interaction.user.id);
      return interaction.reply({ content: 'Your entry has been removed.', ephemeral: true });
    }
    spinParticipants.add(interaction.user.id);
    return interaction.reply({ content: 'You are entered! Good luck 🎉', ephemeral: true });
  }

  // CLAIM: OPEN TICKET (spin system only)
  if (interaction.customId === 'claim_open') {
    if (!spinClaim || spinClaim.resolved || !spinConfig || !spinConfig.active) {
      return interaction.reply({ content: 'This prize claim is no longer active.', ephemeral: true });
    }
    if (interaction.user.id !== spinClaim.winnerId) {
      return interaction.reply({ content: 'Only the winner can respond to this.', ephemeral: true });
    }

    spinClaim.resolved = true;
    if (spinClaim.timeoutHandle) clearTimeout(spinClaim.timeoutHandle);
    await interaction.update({ components: [] }).catch(() => {});

    const { channel: ticketChannel, alreadyExisted } = await createTicketChannel(interaction.guild, interaction.user, {
      namePrefix: 'claim',
      openingMessage: `${interaction.user} congrats on winning **${spinConfig.prize}**! Staff will process your prize here shortly.`,
    });

    // Opening a ticket consumes ONE spin. The giveaway continues if spins remain.
    spinConfig.remainingSpins = Math.max(0, spinConfig.remainingSpins - 1);
    const remaining = spinConfig.remainingSpins;
    const spinChannel = interaction.channel;

    spinClaim = null;
    spinParticipants = new Set();

    await interaction.followUp({
      content: alreadyExisted
        ? `You already have a claim ticket open: ${ticketChannel}`
        : `Your claim ticket has been created: ${ticketChannel}`,
      ephemeral: true,
    });

    if (remaining > 0) {
      await spinChannel.send(`🎫 **Ticket opened!** ${remaining} spin(s) remaining. 🔄 Starting the next spin...`);
      await beginSpinCountdown(spinChannel);
    } else {
      await spinChannel.send('🏁 **All spins completed!** The giveaway has finished.');
      spinConfig = null;
      spinParticipants = new Set();
    }
    return;
  }

  // CLAIM: NOT OPEN TICKET -> respin without consuming a spin
  if (interaction.customId === 'claim_noopen') {
    if (!spinClaim || spinClaim.resolved || !spinConfig || !spinConfig.active) {
      return interaction.reply({ content: 'This prize claim is no longer active.', ephemeral: true });
    }
    if (interaction.user.id !== spinClaim.winnerId) {
      return interaction.reply({ content: 'Only the winner can respond to this.', ephemeral: true });
    }

    spinClaim.resolved = true;
    if (spinClaim.timeoutHandle) clearTimeout(spinClaim.timeoutHandle);
    await interaction.update({ components: [] }).catch(() => {});
    await interaction.followUp('Okay, no ticket will be opened. 🔄 Respinning with the **same entries**...');

    const channel = interaction.channel;
    spinClaim = null;
    // Respin does NOT consume a spin and does NOT clear entries.
    await runSpinShuffle(channel);
    return;
  }
});

// ---------- AUTO-MODERATION (bad words + spam) ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const isModAuthor = isStaffMember(message.member);
  if (isModAuthor) return;

  const lower = message.content.toLowerCase();

  const hasBadWord = BAD_WORDS.some((w) => w && lower.includes(w));
  if (hasBadWord) {
    await message.delete().catch(() => {});
    await issueWarning(message.member, 'Inappropriate language', message.channel);
    return;
  }

  const now = Date.now();
  const timestamps = (spamTracker.get(message.author.id) || []).filter((t) => now - t < SPAM_WINDOW_MS);
  timestamps.push(now);
  spamTracker.set(message.author.id, timestamps);

  if (timestamps.length > SPAM_LIMIT) {
    spamTracker.set(message.author.id, []);
    await issueWarning(message.member, 'Spamming messages', message.channel);
  }
});

// ---------- LEGACY PREFIX COMMANDS (backup) ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const isMod = isStaffMember(message.member);
  const attachedImage = message.attachments.first()?.url || null;

  if (command === 'verify-panel') {
    if (!isMod) return message.reply('Only staff can use this command.');
    return handleVerifyPanel(message.channel);
  }

  if (command === 'ticket-panel') {
    if (!isMod) return message.reply('Only staff can use this command.');
    return handleTicketPanel(message.channel);
  }

  if (command === 'giveaway') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const prize = args.join(' ');
    if (!prize) return message.reply('Usage: `!giveaway <prize>` (attach an image to include it)');
    return startNormalGiveaway(message.channel, prize, 15, attachedImage);
  }

  if (command === 'spin') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const prize = args.join(' ');
    if (!prize) return message.reply('Usage: `!spin <prize>` (attach an image to include it)');
    return startSpinFlow(message.channel, prize, 15, 8, attachedImage);
  }

  if (command === 'spin-cancel') {
    if (!isMod) return message.reply('Only staff can use this command.');
    return stopSpin(message.channel);
  }

  if (command === 'invites') {
    const target = message.mentions.members.first() || message.member;
    const total = await handleInvitesCheck(message.guild, target.user);
    return message.reply(`${target} has **${total}** total invites.`);
  }

  if (command === 'kick') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!kick @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.kick(reason).catch(() => message.reply('Could not kick — check my permissions.'));
    return message.reply(`Kicked ${target.user.tag}. Reason: ${reason}`);
  }

  if (command === 'ban') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!ban @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.ban({ reason }).catch(() => message.reply('Could not ban — check my permissions.'));
    return message.reply(`Banned ${target.user.tag}. Reason: ${reason}`);
  }

  if (command === 'mute') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    const minutes = parseInt(args[1]);
    if (!target || !minutes) return message.reply('Usage: `!mute @user <minutes> [reason]`');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    await target.timeout(minutes * 60000, reason).catch(() => message.reply('Could not mute this member.'));
    return message.reply(`Muted ${target.user.tag} for ${minutes} minute(s).`);
  }

  if (command === 'unmute') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!unmute @user`');
    await target.timeout(null).catch(() => {});
    return message.reply(`Removed the mute from ${target.user.tag}.`);
  }

  if (command === 'warn') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!warn @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    return issueWarning(target, reason, message.channel);
  }

  if (command === 'calendar') {
    try {
      const embed = await handleCalendar();
      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply('Could not fetch the economic calendar right now, try again later.');
    }
  }

  if (command === 'announce') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const text = args.join(' ');
    if (!text) return message.reply('Usage: `!announce <message>`');
    const announceChannel = message.guild.channels.cache.get(process.env.ANNOUNCEMENTS_CHANNEL_ID);
    if (!announceChannel) return message.reply('Announcements channel ID is not set in the environment variables.');
    const embed = new EmbedBuilder().setColor(0x8a3fd9).setDescription(text).setTimestamp();
    await announceChannel.send({ embeds: [embed] });
    return message.reply('Announcement posted ✅');
  }

  if (command === 'help') {
    return message.channel.send({ embeds: [buildHelpEmbed()] });
  }
});

client.login(process.env.BOT_TOKEN);
