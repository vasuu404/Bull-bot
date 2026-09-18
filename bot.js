require('dotenv').config();
const fs = require('fs');
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

// ---------- LINK FILTER (only approved domains allowed) ----------
const ALLOWED_LINK_DOMAINS = (process.env.ALLOWED_LINK_DOMAINS || 'tradingview.com,investing.com,forexfactory.com,discord.com,tenor.com,giphy.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const URL_REGEX = /https?:\/\/([^\s/]+)/gi;

function messageHasDisallowedLink(content) {
  const matches = [...content.matchAll(URL_REGEX)];
  for (const match of matches) {
    const hostname = match[1].toLowerCase().split(':')[0]; // strip port if any
    const isAllowed = ALLOWED_LINK_DOMAINS.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
    if (!isAllowed) return true;
  }
  return false;
}

// ---------- ANTI-RAID PROTECTION ----------
const RAID_JOIN_THRESHOLD = parseInt(process.env.RAID_JOIN_THRESHOLD) || 5;
const RAID_WINDOW_SECONDS = parseInt(process.env.RAID_WINDOW_SECONDS) || 10;
const MIN_ACCOUNT_AGE_HOURS = parseInt(process.env.MIN_ACCOUNT_AGE_HOURS) || 24;

let raidLockdown = false;
let recentJoinTimestamps = [];

// ---------- ADVANCED INVITE TRACKING (fake accounts, rejoins, leaves) ----------
const INVITE_FAKE_ACCOUNT_AGE_HOURS = parseInt(process.env.INVITE_FAKE_ACCOUNT_AGE_HOURS) || 24;
const INVITE_DATA_FILE = './invite-data.json';

// memberId -> { inviterId, inviterTag, code, joinedAt, accountCreatedAt, isFake, leftAt, rejoins }
let memberInviteInfo = new Map();

function loadInviteData() {
  try {
    if (fs.existsSync(INVITE_DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INVITE_DATA_FILE, 'utf8'));
      memberInviteInfo = new Map(Object.entries(raw));
      console.log(`Loaded invite data for ${memberInviteInfo.size} members.`);
    }
  } catch (e) {
    console.log('Could not load invite data:', e.message);
  }
}

function saveInviteData() {
  try {
    const obj = Object.fromEntries(memberInviteInfo);
    fs.writeFileSync(INVITE_DATA_FILE, JSON.stringify(obj));
  } catch (e) {
    console.log('Could not save invite data:', e.message);
  }
}

// Computes real / fake / left counts for one inviter from the tracked data
function getInviterStats(inviterId) {
  let real = 0;
  let fake = 0;
  let left = 0;
  let rejoins = 0;

  for (const info of memberInviteInfo.values()) {
    if (info.inviterId !== inviterId) continue;
    if (info.leftAt) {
      left++;
    } else if (info.isFake) {
      fake++;
    } else {
      real++;
    }
    rejoins += info.rejoins || 0;
  }

  return { real, fake, left, rejoins, netTotal: real };
}

// ---------- CHAT CLEAR + AUTO-CLEAR ----------
const AUTOCLEAR_FILE = './autoclear-config.json';
let autoClearSchedules = new Map(); // channelId -> { minutes, timeoutHandle }

function saveAutoClearConfig() {
  try {
    const obj = {};
    for (const [channelId, sched] of autoClearSchedules.entries()) obj[channelId] = sched.minutes;
    fs.writeFileSync(AUTOCLEAR_FILE, JSON.stringify(obj));
  } catch (e) {
    console.log('Could not save autoclear config:', e.message);
  }
}

function loadAutoClearConfig() {
  try {
    if (fs.existsSync(AUTOCLEAR_FILE)) {
      return JSON.parse(fs.readFileSync(AUTOCLEAR_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('Could not load autoclear config:', e.message);
  }
  return {};
}

// Wipes a channel's ENTIRE history instantly by cloning it (same name/perms/position) and deleting the old one.
async function cloneAndWipeChannel(channel) {
  const newChannel = await channel.clone({ reason: 'Chat clear' });
  try {
    await newChannel.setPosition(channel.position);
  } catch (e) {
    /* position isn't critical, ignore failures */
  }
  await channel.delete().catch(() => {});
  return newChannel;
}

// Recurring auto-clear — re-schedules itself against the fresh channel each cycle
// (since cloning a channel gives it a new ID every time it wipes).
function scheduleAutoClear(channelId, minutes) {
  const existing = autoClearSchedules.get(channelId);
  if (existing && existing.timeoutHandle) clearTimeout(existing.timeoutHandle);

  async function cycle(currentId) {
    const channel = client.channels.cache.get(currentId) || (await client.channels.fetch(currentId).catch(() => null));
    if (!channel) {
      autoClearSchedules.delete(currentId);
      saveAutoClearConfig();
      return;
    }

    try {
      const newChannel = await cloneAndWipeChannel(channel);
      autoClearSchedules.delete(currentId);
      const handle = setTimeout(() => cycle(newChannel.id), minutes * 60000);
      autoClearSchedules.set(newChannel.id, { minutes, timeoutHandle: handle });
      saveAutoClearConfig();
    } catch (e) {
      console.log('Autoclear cycle error:', e.message);
      const handle = setTimeout(() => cycle(currentId), minutes * 60000);
      autoClearSchedules.set(currentId, { minutes, timeoutHandle: handle });
    }
  }

  const handle = setTimeout(() => cycle(channelId), minutes * 60000);
  autoClearSchedules.set(channelId, { minutes, timeoutHandle: handle });
  saveAutoClearConfig();
}

function stopAutoClear(channelId) {
  const sched = autoClearSchedules.get(channelId);
  if (!sched) return false;
  if (sched.timeoutHandle) clearTimeout(sched.timeoutHandle);
  autoClearSchedules.delete(channelId);
  saveAutoClearConfig();
  return true;
}

const seenNewsUrls = new Set();
const NEWS_INTERVAL_MINUTES = parseInt(process.env.NEWS_INTERVAL_MINUTES) || 10;

// Tracks members who joined this session, so only genuinely NEW members get
// tagged in the Rules channel after verifying (not existing members re-verifying).
const recentJoins = new Set(); // userId set

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

  await channel.send(`@here 🎉 A new giveaway just started!`);
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

  // @here ping when the spin countdown begins.
  await channel.send(`@here 🎰 **${spinConfig.prize}** spin giveaway is about to start!`);

  // Separate messages so 3 -> 2 -> 1 are not edits.
  await channel.send('🚨 **SPIN WILL START IN**');
  await channel.send('**3**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send('**2**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send('**1**');
  await new Promise((r) => setTimeout(r, 1000));
  await channel.send('🚨 **ENTER FAST!**');

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

// ---------- FOREX/TRADING NEWS AUTO-POST (RSS-based, not crypto) ----------
const NEWS_RSS_URL = process.env.NEWS_RSS_URL || 'https://www.forexlive.com/feed/news';

async function postTradingNews() {
  if (!process.env.NEWS_CHANNEL_ID) return;
  try {
    const rssApiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(NEWS_RSS_URL)}`;
    const res = await fetch(rssApiUrl);
    const data = await res.json();
    const articles = (data.items || []).slice(0, 5).reverse();

    const channel = client.channels.cache.get(process.env.NEWS_CHANNEL_ID);
    if (!channel) return;

    for (const article of articles) {
      if (seenNewsUrls.has(article.link)) continue;
      seenNewsUrls.add(article.link);

      const plainDescription = (article.description || '').replace(/<[^>]*>/g, '').slice(0, 200);

      const embed = new EmbedBuilder()
        .setColor(0x8a3fd9)
        .setTitle(article.title)
        .setURL(article.link)
        .setDescription(plainDescription ? plainDescription + '...' : '')
        .setFooter({ text: '📰 Forex Market News' })
        .setTimestamp(new Date(article.pubDate));

      // no @here / no member tags on news posts
      await channel.send({ embeds: [embed] }).catch(() => {});
    }

    if (seenNewsUrls.size > 200) {
      const arr = Array.from(seenNewsUrls);
      seenNewsUrls.clear();
      arr.slice(-100).forEach((u) => seenNewsUrls.add(u));
    }
  } catch (e) {
    console.log('News fetch error:', e.message);
  }
}

// ---------- READY ----------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  loadInviteData();

  const savedAutoClear = loadAutoClearConfig();
  for (const [channelId, minutes] of Object.entries(savedAutoClear)) {
    scheduleAutoClear(channelId, minutes);
  }

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

  // weekly economic calendar auto-post
  postWeeklyCalendar();
  setInterval(postWeeklyCalendar, 7 * 24 * 60 * 60000);
});

// ---------- WELCOME + INVITE TRACKING + AUTO-ROLE ----------
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;

  recentJoins.add(member.id);

  // ---------- ANTI-RAID CHECK ----------
  const now = Date.now();
  recentJoinTimestamps = recentJoinTimestamps.filter((t) => now - t < RAID_WINDOW_SECONDS * 1000);
  recentJoinTimestamps.push(now);

  const modLogChannel = guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);

  if (!raidLockdown && recentJoinTimestamps.length >= RAID_JOIN_THRESHOLD) {
    raidLockdown = true;
    if (modLogChannel) {
      modLogChannel.send(
        `🚨 **Possible raid detected!** ${recentJoinTimestamps.length} members joined within ${RAID_WINDOW_SECONDS} seconds.\nAuto-role assignment is now paused for new joins. New accounts younger than ${MIN_ACCOUNT_AGE_HOURS}h will be auto-kicked.\nUse \`/raid-lockdown\` to turn this off manually once it's safe.`
      ).catch(() => {});
    }
  }

  if (raidLockdown) {
    const accountAgeHours = (now - member.user.createdTimestamp) / (1000 * 60 * 60);
    if (accountAgeHours < MIN_ACCOUNT_AGE_HOURS) {
      await member.kick('Anti-raid: new account joined during suspected raid').catch(() => {});
      if (modLogChannel) {
        modLogChannel
          .send(`⛔ Kicked ${member.user.tag} (account age: ${accountAgeHours.toFixed(1)}h) — suspected raid account.`)
          .catch(() => {});
      }
      return; // skip the rest of the normal join flow for this member
    } else if (modLogChannel) {
      modLogChannel
        .send(`⚠️ ${member.user.tag} joined during raid lockdown but has an older account — not auto-kicked, please review.`)
        .catch(() => {});
    }
  }

  if (process.env.MEMBER_ROLE_ID) {
    await member.roles.add(process.env.MEMBER_ROLE_ID).catch(() => {});
  }

  let inviterTag = 'unknown';
  let inviterId = null;
  let usedCode = null;
  try {
    const newInvites = await guild.invites.fetch();
    const oldCodeUses = invitesCache.get(guild.id) || new Collection();
    const used = newInvites.find((inv) => (oldCodeUses.get(inv.code) || 0) < inv.uses);
    if (used && used.inviter) {
      inviterTag = `<@${used.inviter.id}>`;
      inviterId = used.inviter.id;
      usedCode = used.code;
    }

    const updated = new Collection();
    newInvites.forEach((inv) => updated.set(inv.code, inv.uses));
    invitesCache.set(guild.id, updated);
  } catch (e) {
    console.log('Invite tracking error:', e.message);
  }

  // ---------- ADVANCED INVITE TRACKING: fake accounts + rejoin detection ----------
  const accountAgeHoursForInvite = (now - member.user.createdTimestamp) / (1000 * 60 * 60);
  const isFakeAccount = accountAgeHoursForInvite < INVITE_FAKE_ACCOUNT_AGE_HOURS;
  const existingInfo = memberInviteInfo.get(member.id);

  if (existingInfo) {
    // This person was tracked before — they are REJOINING, not a fresh invite.
    // No new invite credit is given to the inviter, preventing leave/rejoin farming.
    existingInfo.leftAt = null;
    existingInfo.rejoins = (existingInfo.rejoins || 0) + 1;
    memberInviteInfo.set(member.id, existingInfo);

    if (modLogChannel) {
      modLogChannel
        .send(`🔁 ${member.user.tag} **rejoined** the server (previously invited by <@${existingInfo.inviterId || 'unknown'}>). No new invite credit given.`)
        .catch(() => {});
    }
  } else if (inviterId) {
    memberInviteInfo.set(member.id, {
      inviterId,
      inviterTag,
      code: usedCode,
      joinedAt: now,
      accountCreatedAt: member.user.createdTimestamp,
      isFake: isFakeAccount,
      leftAt: null,
      rejoins: 0,
    });

    if (isFakeAccount && modLogChannel) {
      modLogChannel
        .send(`⚠️ ${member.user.tag} joined via ${inviterTag}'s invite with a **very new account** (${accountAgeHoursForInvite.toFixed(1)}h old) — flagged as a possible fake invite, not counted as real.`)
        .catch(() => {});
    }
  }
  saveInviteData();

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

client.on('guildMemberRemove', async (member) => {
  const info = memberInviteInfo.get(member.id);
  if (!info || info.leftAt) return; // not tracked, or already marked as left

  info.leftAt = Date.now();
  memberInviteInfo.set(member.id, info);
  saveInviteData();

  const modLogChannel = member.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
  if (modLogChannel && info.inviterId) {
    modLogChannel
      .send(`📤 ${member.user.tag} left the server. This reduces <@${info.inviterId}>'s real invite count by 1.`)
      .catch(() => {});
  }
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

function handleInvitesCheck(targetUserId) {
  return getInviterStats(targetUserId);
}

function buildInviteLeaderboard(limit = 10) {
  const inviterIds = new Set();
  for (const info of memberInviteInfo.values()) {
    if (info.inviterId) inviterIds.add(info.inviterId);
  }

  const rows = Array.from(inviterIds)
    .map((id) => ({ id, ...getInviterStats(id) }))
    .sort((a, b) => b.real - a.real)
    .slice(0, limit);

  return rows;
}

function impactCircle(impact) {
  if (impact === 'High') return '🔴';
  if (impact === 'Medium') return '🟠';
  if (impact === 'Low') return '🟢';
  return '⚪';
}

function formatUtcAndIst(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Time TBA';

  const utcTime = d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const istTime = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

  return `${utcTime} UTC (${istTime} IST)`;
}

async function handleCalendar() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  const data = await res.json();

  // keep Medium + High impact events (skip Low to avoid clutter), sorted by date
  const relevant = data
    .filter((ev) => ev.impact === 'High' || ev.impact === 'Medium' || ev.impact === 'Low')
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 15);

  if (relevant.length === 0) {
    return new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle('📅 This Week — Economic Calendar')
      .setDescription('No events found for this week.');
  }

  const lines = relevant.map((ev) => {
    const circle = impactCircle(ev.impact);
    const timeStr = formatUtcAndIst(ev.date);
    return `${circle} **${ev.title}** (${ev.country})\n${timeStr}`;
  });

  return new EmbedBuilder()
    .setColor(0x8a3fd9)
    .setTitle('📅 This Week — Economic Calendar')
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: '🔴 High  🟠 Medium  🟢 Low impact' });
}

async function postWeeklyCalendar() {
  if (!process.env.ECONOMIC_CALENDAR_CHANNEL_ID) return;
  const channel = client.channels.cache.get(process.env.ECONOMIC_CALENDAR_CHANNEL_ID);
  if (!channel) return;
  try {
    const embed = await handleCalendar();
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.log('Weekly calendar post error:', e.message);
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
      { name: '/invites [user]', value: 'Shows real/fake/left invite breakdown for a member' },
      { name: '/leaderboard', value: 'Shows the top 10 inviters by real invite count' },
      { name: '/kick <user> [reason]', value: 'Kicks a member (staff)' },
      { name: '/ban <user> [reason]', value: 'Bans a member (staff)' },
      { name: '/mute <user> <minutes> [reason]', value: 'Times out a member (staff)' },
      { name: '/unmute <user>', value: 'Removes a timeout (staff)' },
      { name: '/warn <user> [reason]', value: 'Warns a member — 3 warnings = auto-ban (staff)' },
      { name: '/raid-lockdown <on/off>', value: 'Manually toggle anti-raid lockdown mode (staff)' },
      { name: '/clear <amount>', value: 'Deletes the last N messages (up to 100) in this channel (staff)' },
      { name: '/clearall', value: 'Instantly wipes the ENTIRE history of this channel (staff)' },
      { name: '/autoclear <minutes> [channel]', value: 'Automatically wipes a channel on a repeating schedule (staff)' },
      { name: '/autoclear-stop [channel]', value: 'Stops a channel\'s auto-clear schedule (staff)' },
      { name: '/calendar', value: 'Shows this week\'s economic events with UTC + IST times and impact color' },
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

  if (commandName === 'clear') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const amount = interaction.options.getInteger('amount');
    await interaction.reply({ content: `Clearing last ${amount} message(s)...`, ephemeral: true });
    try {
      const deleted = await channel.bulkDelete(amount, true);
      await channel.send(`🧹 Cleared ${deleted.size} message(s).`).then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
    } catch (e) {
      await interaction.followUp({ content: 'Could not clear messages (they may be older than 14 days).', ephemeral: true });
    }
    return;
  }

  if (commandName === 'clearall') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    await interaction.reply({ content: '🧹 Wiping the entire channel history now...', ephemeral: true });
    const newChannel = await cloneAndWipeChannel(channel);
    await newChannel.send('🧹 This channel has been fully cleared by staff.');
    return;
  }

  if (commandName === 'autoclear') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetChannel = interaction.options.getChannel('channel') || channel;
    const minutes = interaction.options.getInteger('minutes');
    scheduleAutoClear(targetChannel.id, minutes);
    return interaction.reply(`✅ ${targetChannel} will now be fully cleared automatically every **${minutes} minute(s)**.`);
  }

  if (commandName === 'autoclear-stop') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const targetChannel = interaction.options.getChannel('channel') || channel;
    const stopped = stopAutoClear(targetChannel.id);
    return interaction.reply(stopped ? `🛑 Auto-clear stopped for ${targetChannel}.` : `${targetChannel} doesn't have an active auto-clear schedule.`);
  }

  if (commandName === 'raid-lockdown') {
    if (!isMod) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    const state = interaction.options.getString('state');
    raidLockdown = state === 'on';
    recentJoinTimestamps = [];
    return interaction.reply(`Raid lockdown is now **${raidLockdown ? 'ON' : 'OFF'}**.`);
  }

  if (commandName === 'invites') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const stats = handleInvitesCheck(targetUser.id);
    const embed = new EmbedBuilder()
      .setColor(0x8a3fd9)
      .setTitle(`📨 Invite Stats — ${targetUser.username}`)
      .addFields(
        { name: '✅ Real', value: `${stats.real}`, inline: true },
        { name: '⚠️ Fake', value: `${stats.fake}`, inline: true },
        { name: '📤 Left', value: `${stats.left}`, inline: true }
      )
      .setFooter({ text: 'Fake = very new accounts. Left = they joined then left (no longer counted).' });
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'leaderboard') {
    const rows = buildInviteLeaderboard(10);
    if (rows.length === 0) return interaction.reply('No invite data tracked yet.');
    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.id}> — ✅ ${r.real} real | ⚠️ ${r.fake} fake | 📤 ${r.left} left`);
    const embed = new EmbedBuilder().setColor(0x8a3fd9).setTitle('🏆 Invite Leaderboard').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed] });
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

    // Only tag genuinely new members (who joined this session) in the Rules channel.
    if (recentJoins.has(interaction.user.id)) {
      recentJoins.delete(interaction.user.id);
      const rulesChannel = interaction.guild.channels.cache.get(process.env.RULES_CHANNEL_ID);
      if (rulesChannel) {
        rulesChannel
          .send(`👋 ${interaction.user} welcome aboard! Please take a moment to read the rules above. 📜`)
          .catch(() => {});
      }
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

  if (messageHasDisallowedLink(message.content)) {
    await message.delete().catch(() => {});
    await issueWarning(message.member, 'Posted a link that is not from an approved site', message.channel);
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

  if (command === 'clear') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const amount = parseInt(args[0]);
    if (!amount || amount < 1 || amount > 100) return message.reply('Usage: `!clear <1-100>`');
    try {
      await message.delete().catch(() => {});
      const deleted = await message.channel.bulkDelete(amount, true);
      message.channel.send(`🧹 Cleared ${deleted.size} message(s).`).then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
    } catch (e) {
      message.channel.send('Could not clear messages (they may be older than 14 days).');
    }
    return;
  }

  if (command === 'clearall') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const newChannel = await cloneAndWipeChannel(message.channel);
    newChannel.send('🧹 This channel has been fully cleared by staff.');
    return;
  }

  if (command === 'autoclear') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const minutes = parseInt(args[0]);
    if (!minutes) return message.reply('Usage: `!autoclear <minutes>` (run this in the channel you want auto-cleared)');
    scheduleAutoClear(message.channel.id, minutes);
    return message.reply(`✅ This channel will now be fully cleared automatically every **${minutes} minute(s)**.`);
  }

  if (command === 'autoclear-stop') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const stopped = stopAutoClear(message.channel.id);
    return message.reply(stopped ? '🛑 Auto-clear stopped for this channel.' : "This channel doesn't have an active auto-clear schedule.");
  }

  if (command === 'raid-lockdown') {
    if (!isMod) return message.reply('Only staff can use this command.');
    const state = args[0];
    raidLockdown = state === 'on';
    recentJoinTimestamps = [];
    return message.reply(`Raid lockdown is now **${raidLockdown ? 'ON' : 'OFF'}**.`);
  }

  if (command === 'invites') {
    const target = message.mentions.members.first() || message.member;
    const stats = handleInvitesCheck(target.id);
    return message.reply(`${target} — ✅ ${stats.real} real | ⚠️ ${stats.fake} fake | 📤 ${stats.left} left`);
  }

  if (command === 'leaderboard') {
    const rows = buildInviteLeaderboard(10);
    if (rows.length === 0) return message.reply('No invite data tracked yet.');
    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.id}> — ✅ ${r.real} real | ⚠️ ${r.fake} fake | 📤 ${r.left} left`);
    const embed = new EmbedBuilder().setColor(0x8a3fd9).setTitle('🏆 Invite Leaderboard').setDescription(lines.join('\n'));
    return message.channel.send({ embeds: [embed] });
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
