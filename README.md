# GCore Web Tycoon 🟣

A fully **online, multiplayer** generator tycoon for [gcoremc.com](https://gcoremc.com) — the GCore experience on the web. Players walk around a shared world, see each other in real time, claim a personal plot, build & upgrade generators through 10 tiers, prestige, earn tokens, climb a live leaderboard, and chat.

Built to match the GCore site theme (purple/gold, Space Grotesk).

```
gcore-tycoon/
├── server.js          ← Node + WebSocket game server (presence, chat, leaderboard, saves)
├── package.json
├── public/
│   └── index.html     ← The whole game client (canvas, movement, shops, HUD)
└── tycoondata.json    ← auto-created; everyone's saved progress
```

---

## How it works

- **Server-authoritative** on the stuff that has to be shared: who's online, where everyone is, chat, the leaderboard, and saving progress.
- **Economy runs on the client** for snappy, lag-free clicking, then syncs up to the server every 2s so your money/prestige/gens are saved and visible to other players walking past your plot.
- Each player name gets a **persistent account** and a **personal plot** in the world grid. Come back later with the same name and your empire is still there.

### Controls
| Key | Action |
|-----|--------|
| **WASD / Arrows** | Walk |
| **E** | Use the shop pad you're standing on |
| **Click a generator** (on your plot) | Upgrade it |
| **Enter** | Chat |
| **⌖ My Plot / ⌂ Spawn** buttons | Fast travel |

### The loop
1. Spawn in the **hub**. Three pads: **Generator Shop**, **Token Shop**, **Prestige**.
2. Buy a Carbon Gen → it drops cash on your plot → walk over drops to collect.
3. Collecting gives **XP** → **levels** → **Tokens**.
4. Upgrade gens through 10 tiers (Carbon → Amber). Spend Tokens on **+gen slots** and **+multiplier**.
5. Hit the prestige requirement → **Prestige** for +0.1x permanent multi and +2 gen slots.
6. Climb the **Top Tycoons** leaderboard (ranked by prestige).

---

## Run it locally

```bash
cd gcore-tycoon
npm install
npm start
```
Open **http://localhost:3000** in two browser tabs, use two different names, and watch them see each other.

---

## Deploy free on Render (same as the editor)

1. Push this folder to a new GitHub repo (e.g. `Shaggie420/gcore-tycoon`):
   ```bash
   cd gcore-tycoon
   git init
   git add .
   git commit -m "GCore web tycoon"
   git branch -M main
   git remote add origin https://github.com/Shaggie420/gcore-tycoon.git
   git push -u origin main
   ```
2. On [render.com](https://render.com) → **New → Web Service** → connect that repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Create Web Service**. When it's live you'll get a URL like `https://gcore-tycoon.onrender.com`.

> Render's free tier spins down after ~15 min idle, so the first visit after a quiet spell takes ~30s to wake up. That's normal.

### Persistent saves on Render (optional but recommended)
The free tier's disk is wiped on each redeploy. To keep everyone's progress permanently, add a **Disk** in the Render service settings:
- **Mount Path:** `/data`
- **Size:** 1 GB

…then set an env var `DATA_DIR=/data` (the server already falls back to its own folder if you don't). Saves land in `tycoondata.json` on that disk.

---

## Link it from the website

On **gcoremc.com**, point the "Play Web Tycoon" button at your Render URL:
```html
<a href="https://gcore-tycoon.onrender.com" target="_blank">Play Web Tycoon</a>
```
Or embed it full-screen in a `game.html` page with an `<iframe>`.

---

## Tuning the game

Everything lives in two files:

- **Generator tiers / costs / drop values** → top of `public/index.html`, the `TIERS` array.
- **Prestige cost, XP curve, token prices, buy-gen scaling** → the `ECONOMY` section in `public/index.html`.
- **World size, plot grid, hub size** → top of `server.js` (`WORLD_W`, `PLOT_COLS`, etc.). Keep these in sync with what the client receives via the `init` message (it already reads them from the server, so just edit `server.js`).

No build step, no framework — edit, refresh, done.
