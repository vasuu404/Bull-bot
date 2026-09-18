# 🐂 Bull Bot — Bulls & Chill

Custom bot for a forex trading community. All commands are **slash commands** (`/`) — type `/` in any channel to see the full list pop up.

## What's new in this update

- **`@here`** ping added back to both the normal `/giveaway` and `/spin` announcements.
- **News switched from crypto to forex** — now pulls from a forex RSS feed (ForexLive by default, configurable via `NEWS_RSS_URL`), posts every **10 minutes**, with **no @here / no member tags** on news posts.
- **Economic calendar overhaul**:
  - Shows 🔴 High / 🟠 Medium / 🟢 Low impact circles per event
  - Every event now shows **both UTC and IST time**, e.g. `14:30 UTC (20:00 IST)`
  - Auto-posts **once a week** to a dedicated channel (`ECONOMIC_CALENDAR_CHANNEL_ID`), in addition to the `/calendar` command
- **New-member Rules tag** — right after a genuinely **new** member verifies, the bot tags them once in the Rules channel ("welcome, please read the rules"). Existing members re-verifying are **never** tagged again.

## Features
- Welcome message + auto Member role
- Invite tracking (`/invites`)
- Verification button (`/verify-panel`) + auto Rules-channel tag for new members
- Ticket system (`/ticket-panel`)
- Normal Giveaway — simple entry + plain winner announcement (`/giveaway`)
- Spin Giveaway — countdown, slot-machine style shuffle, ticket claim with 1-min timer, auto-respin (`/spin`, `/spin-cancel`)
- Moderation: kick, ban, mute, unmute, warn (auto-ban at 3 warnings)
- Auto-moderation: bad word filter + spam filter (auto-warns)
- Forex news auto-posted every 10 minutes
- Weekly economic calendar (auto-post + `/calendar` command)
- Announcements (`/announce`)

## Environment variables (Railway → Variables)

Fill in every value from `.env.example`. Two are **new** in this update:

- `RULES_CHANNEL_ID` — the channel where new members get tagged after verifying
- `ECONOMIC_CALENDAR_CHANNEL_ID` — the channel where the weekly calendar auto-posts
- `NEWS_INTERVAL_MINUTES` — set to `10` (already the default)
- `NEWS_RSS_URL` — optional, change the forex news source if you want a different feed

## How the Giveaway + Spin + Claim flow works

1. Staff runs `/giveaway prize:"$10 Steam Card" seconds:15` for a **simple** giveaway (just enters + plain winner announcement), or `/spin prize:"$10 Steam Card" seconds:15 spins:8` for the **full spin experience**.
2. `@here` announces it, then (for spin) a 3-2-1 countdown plays before entries open.
3. When entries close, the bot picks a winner — spin mode shows a slot-machine style shuffle animation first.
4. The winner gets tagged with **🎫 Open Ticket** / **🔄 Respin** buttons, with **1 minute** to respond.
   - **Open Ticket** → a private `claim-username` channel is created for staff to hand over the prize. If more spins remain, the next spin round starts automatically with fresh entries.
   - **Respin**, or no response within 1 minute → the **same entries are reused** and the wheel spins again immediately (nobody has to re-enter).

## 1. Create the bot (Developer Portal)

1. Go to: https://discord.com/developers/applications
2. **New Application** → name it **Bull**
3. Copy the **Application ID** from the General Information page.
4. **"Bot"** tab → **Reset Token** → copy the token (never share this)
5. Under **Privileged Gateway Intents**, turn ON:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
6. **"OAuth2" → "URL Generator"**:
   - Scopes: ✅ `bot` and ✅ `applications.commands`
   - Bot Permissions: ✅ `Administrator`
7. Copy the generated URL, open it, select your server, and **Authorize**.

## 2. Turn on Developer Mode in Discord (to copy IDs)

Discord app → Settings → **Advanced** → **Developer Mode** ON.
Right-click any role/channel/server to **Copy ID**.

## 3. Set up your `.env` / Railway Variables

Copy every key from `.env.example` and fill in the values — see the **new variables** section above.

## 4. Run the bot

```
npm install
npm start
```

`npm start` registers slash commands **and** starts the bot every time — so every Railway redeploy keeps commands up to date automatically.

## 5. After setup, in Discord

- In `#verification`: run `/verify-panel`
- In `#support-ticket`: run `/ticket-panel`
- To see every command: run `/help`

That's it — the bot now handles your whole server! 🐂
