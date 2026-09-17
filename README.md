# 🐂 Bull Bot — Bulls & Chill

Custom bot jo tumhare server ka ye sab kaam karega:
- Welcome message + auto Member role
- Invite tracking (`!invites`)
- Verification button (`!verify-panel`)
- Ticket system (`!ticket-panel`)
- Giveaways with a Join button (`!giveaway`)
- Moderation: kick, ban, mute, unmute
- Announcements (`!announce`)

## 1. Bot banane ka setup (Developer Portal)

1. Jao: https://discord.com/developers/applications
2. **New Application** → naam do **Bull**
3. Left side **"Bot"** tab → **Reset Token** → token copy karo (isse kisi ko mat dena)
4. Bot tab mein neeche **Privileged Gateway Intents** section mein ye 2 ON karo:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
5. Left side **"OAuth2" → "URL Generator"**:
   - Scopes: ✅ `bot`
   - Bot Permissions: ✅ `Administrator` (simplest — sab permissions mil jayengi)
6. Neeche generate hua URL copy karo, browser mein paste karo, apna server select karke **Authorize** karo.

## 2. Discord mein Developer Mode ON karo (IDs copy karne ke liye)

Discord app → Settings → **Advanced** → **Developer Mode** ON kar do.
Ab kisi bhi role/channel/server pe right-click karke **"Copy ID"** milega.

## 3. `.env` file banao

`.env.example` file ko copy karke naam `.env` rakho, aur saari values fill karo:
- `BOT_TOKEN` — jo step 1 mein copy kiya
- `GUILD_ID` — apne server pe right-click → Copy Server ID
- Baaki sab role/channel IDs — usi tarah copy karke fill karo

## 4. Bot chalao

Terminal/CMD mein `bull-bot` folder ke andar jaake:

```
npm install
npm start
```

Agar apne phone/PC se 24x7 chalana hai to **Railway.app** ya **Render.com** (dono free tier dete hain) pe deploy kar sakte ho — sirf ye folder upload karo aur environment variables wahan ke dashboard mein daal do.

## 5. Setup ke baad Discord mein

- `#verification` channel mein: `!verify-panel` bhejo
- `#support-ticket` channel mein: `!ticket-panel` bhejo
- Kisi bhi giveaway channel mein: `!giveaway 60 $10 Steam Card` (60 minute ka giveaway)
- Har command dekhne ke liye: `!help`

Bas itna hi — bot ab tumhare server ka poora kaam sambhal lega! 🐂
