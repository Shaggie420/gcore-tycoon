// ==========================================================
//  GCORE WEB TYCOON — multiplayer game server
//  - WebSocket presence/movement so everyone sees each other
//  - Per-player persisted economy (money, tokens, prestige, gens)
//  - Shared leaderboard + global chat
//  Economy is simulated client-side for responsiveness and
//  synced here so progress is saved and visible to others.
// ==========================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// Hash a password before storing it (never store the raw password).
function hashPass(p) {
  return crypto.createHash('sha256').update('gcore_tycoon:' + p).digest('hex');
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
// DATA_DIR lets Render mount a persistent disk (e.g. /data) so saves survive redeploys.
const DATA_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR) ? process.env.DATA_DIR : __dirname;
const SAVE_FILE = path.join(DATA_DIR, 'tycoondata.json');

// ---- Persistent account store (keyed by lowercase name) ----
// Durable by env var: if MONGODB_URI is set we save to a (free) cloud database
// so accounts survive restarts on ANY host. With no URI we fall back to the
// local JSON file — fine on your own PC, but ephemeral hosts (Render free tier,
// etc.) wipe that file on restart/sleep, which is why saves were disappearing.
let accounts = {};
let mongoCol = null;
try { accounts = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (e) { accounts = {}; }

function saveToFile() {
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(accounts)); } catch (e) {}
}

async function saveAccounts() {
  if (mongoCol) {
    try {
      const ops = Object.keys(accounts).map(k => ({
        updateOne: { filter: { _id: k }, update: { $set: { data: accounts[k] } }, upsert: true }
      }));
      if (ops.length) await mongoCol.bulkWrite(ops);
      return;
    } catch (e) { console.error('[store] mongo save failed, writing file instead:', e.message); }
  }
  saveToFile();
}

async function initStore() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    if (process.env.DATA_DIR && DATA_DIR === process.env.DATA_DIR) {
      console.log('[store] ✅ DURABLE — saving to persistent volume: ' + SAVE_FILE);
    } else {
      console.log('[store] ⚠️ EPHEMERAL FILE mode — data will be wiped on restart. Attach a volume + set DATA_DIR (or set MONGODB_URI).');
    }
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    mongoCol = client.db(process.env.MONGODB_DB || 'gcore_tycoon').collection('accounts');
    const docs = await mongoCol.find({}).toArray();
    if (docs.length) { accounts = {}; for (const d of docs) accounts[d._id] = d.data; }
    console.log('[store] MongoDB connected — loaded ' + docs.length + ' account(s); saves are now permanent');
  } catch (e) {
    console.error('[store] MongoDB unavailable (' + e.message + ') — falling back to local file');
    mongoCol = null;
  }
}
initStore();

setInterval(saveAccounts, 15000);
// Flush one last time when the host stops/restarts the instance.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { try { await saveAccounts(); } catch (e) {} process.exit(0); });
}

// ---- Live players (this session) ----
// id -> { ws, name, key, x, y, plot, dir, stats }
let players = {};
let nextId = 1;

const WORLD_W = 4200, WORLD_H = 3400;
const HUB = { x: WORLD_W / 2, y: 420, w: 1200, h: 620 };
const PLOT_COLS = 6, PLOT_W = 620, PLOT_H = 560, PLOT_GAP = 60;
const PLOT_TOP = 1150;

function plotRect(index) {
  const col = index % PLOT_COLS;
  const row = Math.floor(index / PLOT_COLS);
  const totalW = PLOT_COLS * PLOT_W + (PLOT_COLS - 1) * PLOT_GAP;
  const startX = (WORLD_W - totalW) / 2;
  return {
    x: startX + col * (PLOT_W + PLOT_GAP),
    y: PLOT_TOP + row * (PLOT_H + PLOT_GAP),
    w: PLOT_W, h: PLOT_H
  };
}

function blankStats() {
  return {
    money: 50, tokens: 0, prestige: 0, level: 1, xp: 0, // start with $50 to buy a first gen
    genSlots: 6, multi: 1,
    gens: [], // [{tier, slot, stored}]
    skin: { body: '#a463d6', hat: 0 }, // wardrobe appearance
    farmXP: 0, activeCrop: 1          // farming progress
  };
}

function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const id in players) {
    if (id == exceptId) continue;
    const p = players[id];
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function leaderboard() {
  return Object.values(accounts)
    .map(a => ({ name: a.name, prestige: a.stats.prestige || 0, money: a.stats.money || 0 }))
    .sort((a, b) => (b.prestige - a.prestige) || (b.money - a.money))
    .slice(0, 10);
}

wss.on('connection', (ws) => {
  const id = nextId++;
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'join') {
      const name = ('' + (m.name || 'Player')).slice(0, 16).replace(/[^a-zA-Z0-9_]/g, '') || 'Player';
      const key = name.toLowerCase();
      const pass = '' + (m.pass || '');
      if (pass.length < 3) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Password must be at least 3 characters.' }));
        return;
      }
      const ph = hashPass(pass);
      // Load or create the account
      if (!accounts[key]) {
        // New account — claim this username + password
        accounts[key] = { name, pass: ph, stats: blankStats(), plot: Object.keys(accounts).length };
      }
      const acc = accounts[key];
      // Migrate older accounts that have no password yet: first login sets it.
      if (!acc.pass) acc.pass = ph;
      // Verify the password for existing accounts.
      if (acc.pass !== ph) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Wrong password for that username.' }));
        return;
      }
      acc.name = name;
      const spawn = { x: HUB.x, y: HUB.y + 120 };
      player = {
        ws, id, name, key,
        x: spawn.x, y: spawn.y, dir: 0,
        plot: acc.plot,
        stats: acc.stats
      };
      players[id] = player;

      // Offline time so the client can grant capped "while you were away" earnings.
      const awayMs = acc.lastSeen ? Math.max(0, Date.now() - acc.lastSeen) : 0;
      acc.lastSeen = Date.now();
      // Make sure older accounts have the newer fields.
      if (!acc.stats.skin) acc.stats.skin = { body: '#a463d6', hat: 0 };
      if (acc.stats.farmXP == null) acc.stats.farmXP = 0;
      if (acc.stats.activeCrop == null) acc.stats.activeCrop = 1;
      // Tell the new player everything
      ws.send(JSON.stringify({
        t: 'init',
        id, awayMs,
        you: { name, plot: acc.plot, stats: acc.stats },
        world: { w: WORLD_W, h: WORLD_H, hub: HUB, plotCols: PLOT_COLS, plotW: PLOT_W, plotH: PLOT_H, plotGap: PLOT_GAP, plotTop: PLOT_TOP },
        plotRect: plotRect(acc.plot)
      }));
      // Send current player list to the newcomer
      ws.send(JSON.stringify({ t: 'players', list: snapshot() }));
      ws.send(JSON.stringify({ t: 'leaderboard', list: leaderboard() }));
      broadcast({ t: 'chat', name: 'SERVER', msg: `${name} joined the tycoon!`, sys: true });
      return;
    }

    if (!player) return;

    if (m.t === 'move') {
      player.x = Math.max(0, Math.min(WORLD_W, +m.x || 0));
      player.y = Math.max(0, Math.min(WORLD_H, +m.y || 0));
      player.dir = +m.dir || 0;
      return;
    }

    if (m.t === 'sync') {
      // Trust the client's economy snapshot (fun game, not banking)
      const s = m.stats || {};
      const st = player.stats;
      st.money = +s.money || 0;
      st.tokens = +s.tokens || 0;
      st.prestige = +s.prestige || 0;
      st.level = +s.level || 1;
      st.xp = +s.xp || 0;
      st.genSlots = +s.genSlots || 6;
      st.multi = +s.multi || 1;
      if (Array.isArray(s.gens)) st.gens = s.gens.slice(0, 64);
      if (s.skin && typeof s.skin === 'object') st.skin = { body: ('' + (s.skin.body || '#a463d6')).slice(0, 9), hat: +s.skin.hat || 0 };
      st.farmXP = +s.farmXP || 0;
      st.activeCrop = +s.activeCrop || 1;
      // keep lastSeen fresh so a crash still gives sane offline earnings
      if (accounts[player.key]) accounts[player.key].lastSeen = Date.now();
      return;
    }

    if (m.t === 'chat') {
      const msg = ('' + (m.msg || '')).slice(0, 200);
      if (msg.trim().length === 0) return;
      broadcast({ t: 'chat', name: player.name, msg });
      return;
    }
  });

  ws.on('close', () => {
    if (player) {
      if (accounts[player.key]) accounts[player.key].lastSeen = Date.now();
      broadcast({ t: 'leave', id: player.id });
      delete players[id];
      saveAccounts();
    }
  });
});

// Lightweight per-player snapshot for rendering others (positions + builds)
function snapshot() {
  return Object.values(players).map(p => ({
    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir,
    plot: p.plot, prestige: p.stats.prestige || 0, gens: p.stats.gens || [],
    skin: p.stats.skin || { body: '#a463d6', hat: 0 }
  }));
}

// Broadcast world state ~12 times a second
setInterval(() => {
  const snap = snapshot();
  const msg = JSON.stringify({ t: 'players', list: snap });
  for (const id in players) {
    const p = players[id];
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}, 80);

// Broadcast leaderboard every 5s
setInterval(() => {
  broadcast({ t: 'leaderboard', list: leaderboard() });
}, 5000);

app.get('/healthz', (req, res) => res.send('ok'));
server.listen(PORT, () => console.log('GCore Tycoon server on :' + PORT));
