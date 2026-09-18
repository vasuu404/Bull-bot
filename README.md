# 🐂 Bull Bot — Bulls & Chill

Custom bot for your server. Everything now runs on **slash commands** (`/`) — type `/` in any channel and Discord will show the full list automatically.

## Features
- Welcome message + auto Member role
- Invite tracking (`/invites`)
- Verification button (`/verify-panel`)
- Ticket system (`/ticket-panel`)
- Giveaway + Spin Wheel + Claim flow (`/giveaway`, `/spin`)
- Moderation: kick, ban, mute, unmute, warn (auto-ban at 3 warnings)
- Auto-moderation: bad word filter + spam filter (auto-warns)
- Auto-posted trading news
- Economic calendar (`/calendar`)
- Announcements (`/announce`)

## How the Giveaway + Spin + Claim flow works

1. Staff runs `/giveaway prize:"$10 Steam Card" seconds:15`
   - A message posts with a **Join** button. Entries stay open for the given seconds (default 15).
2. When time's up (or staff runs `/spin` early), the bot picks a random entrant and shows a **spinning** animation before landing on the winner.
3. The winner gets tagged with two buttons: **✅ Open Ticket** and **❌ Not Open Ticket**, with **1 minute** to respond.
   - **Open Ticket** → a private `claim-username` channel is created for staff to hand over the prize.
   - **Not Open Ticket**, or no response within 1 minute → the winner is excluded, and staff can run `/spin` again to pick a new winner from the remaining entries.

## 1. Create the bot (Developer Portal)

1. Go to: https://discord.com/developers/applications
2. **New Application** → name it **Bull**
3. On the main page (General Information), copy the **Application ID** — you'll need it below.
4. Left side **"Bot"** tab → **Reset Token** → copy the token (never share this)
5. In the Bot tab, under **Privileged Gateway Intents**, turn ON:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
6. Left side **"OAuth2" → "URL Generator"**:
   - Scopes: ✅ `bot` and ✅ `applications.commands`
   - Bot Permissions: ✅ `Administrator`
7. Copy the generated URL, open it in a browser, select your server, and **Authorize**.

## 2. Turn on Developer Mode in Discord (to copy IDs)

Discord app → Settings → **Advanced** → **Developer Mode** ON.
Now right-click any role/channel/server to **Copy ID**.

## 3. Set up your `.env`

Copy `.env.example` to `.env` and fill in every value:
- `BOT_TOKEN` — from step 1
- `APPLICATION_ID` — from step 1 (General Information page)
- `GUILD_ID` — right-click your server → Copy Server ID
- All the role/channel IDs — copy the same way

## 4. Run the bot

```
npm install
npm start
```

`npm start` automatically registers your slash commands with Discord **and** starts the bot every time it runs — so on Railway, every redeploy keeps the commands up to date. No separate step needed.

If hosting yourself 24x7, use **Railway.app** or **Render.com** (both have free tiers) — upload this folder and set the environment variables in their dashboard.

## 5. After setup, in Discord

- In `#verification`: run `/verify-panel`
- In `#support-ticket`: run `/ticket-panel`
- To see every command: run `/help`

That's it — the bot now handles your whole server! 🐂
