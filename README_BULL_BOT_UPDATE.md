# Bull Bot update

This build keeps the existing giveaway/spin/verification/ticket system and adds:

- `@here` on spin-giveaway start/countdown announcements only.
- New members are tracked on `guildMemberAdd`.
- After a new member verifies, Bull Bot mentions that member in `RULES_CHANNEL_ID`.
- Existing members are not automatically tagged.
- Forex/trading news posts every 15 minutes to `NEWS_CHANNEL_ID`.
- News posts explicitly suppress all mentions (`allowedMentions: { parse: [] }`).
- Weekly high-impact economic calendar posts to `ECONOMIC_CALENDAR_CHANNEL_ID`.
- Calendar times are displayed as `UTC (IST)`.
- `/calendar` also uses the UTC + IST format.

## Railway variables

Keep your existing variables and add/check these:

```env
NEWS_CHANNEL_ID=YOUR_NEWS_CHANNEL_ID
RULES_CHANNEL_ID=YOUR_RULES_CHANNEL_ID
ECONOMIC_CALENDAR_CHANNEL_ID=YOUR_ECONOMIC_CALENDAR_CHANNEL_ID
FOREX_NEWS_FEED_URL=https://www.investing.com/rss/news_285.rss
```

`FOREX_NEWS_FEED_URL` is optional; the bot uses the shown default if it is not set.

The existing variables such as `BOT_TOKEN`, `APPLICATION_ID`, `GUILD_ID`,
`VERIFIED_ROLE_ID`, `MEMBER_ROLE_ID`, etc. remain unchanged.

## Important Discord permissions

The bot needs permission to:

- Mention `@here` in the spin channel.
- Send messages in the Rules, News, and Economic Calendar channels.
- Add the verified role.
- Read/send messages as required by the existing bot.

For the `@here` ping, make sure the bot's role/channel permissions allow `@everyone, @here, and all roles to be mentioned`.

## Files

- `bot.js`
- `deploy-commands.js`
