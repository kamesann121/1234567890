// server/index.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-admin-token';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

const db = new Database(DB_PATH);
const schemaPath = path.join(__dirname, 'schema.sql');
if (fs.existsSync(schemaPath)) db.exec(fs.readFileSync(schemaPath, 'utf8'));

// ensure default shop items
const SHOP_DEFAULTS = [
  { id: 'cheapUp', name: 'タップ力 +1', price: 10, type: 'tap', value: 1 },
  { id: 'midUp', name: 'タップ力 +5', price: 45, type: 'tap', value: 5 },
  { id: 'auto1', name: '自動収入 +1/s', price: 30, type: 'auto', value: 1 },
  { id: 'auto5', name: '自動収入 +5/s', price: 130, type: 'auto', value: 5 }
];
const insertItem = db.prepare('INSERT OR IGNORE INTO shop_items (id,name,price,type,value) VALUES (@id,@name,@price,@type,@value)');
for (const it of SHOP_DEFAULTS) insertItem.run(it);

// prepared statements
const findPlayer = db.prepare('SELECT * FROM players WHERE nickname = ?');
const createPlayer = db.prepare('INSERT INTO players (nickname,coins,tap_value,auto_per_sec,taps,icon) VALUES (@nickname,@coins,@tap_value,@auto_per_sec,@taps,@icon)');
const updatePlayerCoinsTap = db.prepare('UPDATE players SET coins=@coins, tap_value=@tap_value, auto_per_sec=@auto_per_sec, taps=@taps, icon=@icon WHERE nickname=@nickname');
const updatePlayerAfterTap = db.prepare('UPDATE players SET coins=coins+@val, taps=taps+1 WHERE nickname=@nickname');
const updatePlayerAfterAuto = db.prepare('UPDATE players SET coins=coins+@val WHERE nickname=@nickname');
const getTopRank = db.prepare('SELECT nickname, taps, coins, icon FROM players ORDER BY taps DESC LIMIT 100');
const listPlayers = db.prepare('SELECT nickname, coins, taps, icon FROM players ORDER BY nickname');
const insertChat = db.prepare('INSERT INTO chat (nickname,icon,text,ts) VALUES (@nickname,@icon,@text,@ts)');
const recentChats = db.prepare('SELECT nickname,icon,text,ts FROM chat ORDER BY id DESC LIMIT 200');
const findBan = db.prepare('SELECT * FROM bans WHERE nickname = ?');
const addBan = db.prepare('INSERT OR REPLACE INTO bans (nickname,reason) VALUES (?,?)');
const removeBan = db.prepare('DELETE FROM bans WHERE nickname = ?');
const shopAll = db.prepare('SELECT id,name,price,type,value FROM shop_items');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/icons', express.static(ICON_DIR, { index: false }));

const upload = multer({ dest: ICON_DIR, limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/upload-icon', upload.single('icon'), (req, res) => {
  const nickname = String(req.body.nickname || '').slice(0,32);
  if (!req.file || !nickname) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: 'missing' });
  }
  const ext = path.extname(req.file.originalname).toLowerCase();
  const allowed = ['.png','.jpg','.jpeg','.gif',''];
  if (!allowed.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: 'invalid_ext' });
  }
  const newName = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
  const dst = path.join(ICON_DIR, newName);
  fs.renameSync(req.file.path, dst);
  const iconUrl = `/icons/${newName}`;
  const player = findPlayer.get(nickname);
  if (player) {
    updatePlayerCoinsTap.run({ coins: player.coins, tap_value: player.tap_value, auto_per_sec: player.auto_per_sec, taps: player.taps, icon: iconUrl, nickname });
  } else {
    createPlayer.run({ nickname, coins: 0, tap_value: 1, auto_per_sec: 0, taps: 0, icon: iconUrl });
  }
  res.json({ ok: true, icon: iconUrl });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // ws -> nickname

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(str);
}
function sendTo(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws) => {
  clients.set(ws, null);
  const shop = shopAll.all();
  const ranks = getTopRank.all();
  const chats = recentChats.all().reverse();
  sendTo(ws, { type: 'init', shop, ranks, chats });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'setName') {
      const nickname = String(data.nickname || '').trim().slice(0,32);
      if (!nickname) { sendTo(ws, { type: 'setNameResult', ok: false, reason: 'empty' }); return; }
      // admin special: must provide token
      if (nickname.toLowerCase() === 'admin') {
        if (data.adminToken !== ADMIN_TOKEN) { sendTo(ws, { type: 'setNameResult', ok: false, reason: 'admin_auth' }); return; }
      }
      const banned = findBan.get(nickname);
      if (banned) { sendTo(ws, { type: 'setNameResult', ok: false, reason: 'banned' }); return; }
      const inUse = Array.from(clients.values()).some(n => n === nickname);
      if (inUse) { sendTo(ws, { type: 'setNameResult', ok: false, reason: 'inuse' }); return; }
      if (!findPlayer.get(nickname)) createPlayer.run({ nickname, coins: 0, tap_value: 1, auto_per_sec: 0, taps: 0, icon: null });
      clients.set(ws, nickname);
      sendTo(ws, { type: 'setNameResult', ok: true, nickname });
      broadcastPlayersAndRanks();
      return;
    }

    const nickname = clients.get(ws);
    if (!nickname) { sendTo(ws, { type: 'error', error: 'not_named' }); return; }

    if (data.type === 'tap') {
      const player = findPlayer.get(nickname);
      if (!player) return;
      updatePlayerAfterTap.run({ val: player.tap_value, nickname });
      const updated = findPlayer.get(nickname);
      broadcast({ type: 'tap', nickname: updated.nickname, coins: updated.coins, taps: updated.taps, tap_value: updated.tap_value });
      return;
    }

    if (data.type === 'buy') {
      const itemId = String(data.itemId || '');
      const item = db.prepare('SELECT id,name,price,type,value FROM shop_items WHERE id = ?').get(itemId);
      if (!item) { sendTo(ws, { type: 'buyResult', ok: false, reason: 'invalid' }); return; }
      const player = findPlayer.get(nickname);
      if (player.coins < item.price) { sendTo(ws, { type: 'buyResult', ok: false, reason: 'not_enough' }); return; }
      const newCoins = player.coins - item.price;
      const newTap = item.type === 'tap' ? player.tap_value + item.value : player.tap_value;
      const newAuto = item.type === 'auto' ? player.auto_per_sec + item.value : player.auto_per_sec;
      updatePlayerCoinsTap.run({ coins: newCoins, tap_value: newTap, auto_per_sec: newAuto, taps: player.taps, icon: player.icon, nickname });
      const updated = findPlayer.get(nickname);
      sendTo(ws, { type: 'buyResult', ok: true, user: { nickname: updated.nickname, coins: updated.coins, tap_value: updated.tap_value, auto_per_sec: updated.auto_per_sec } });
      broadcastPlayersAndRanks();
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').slice(0,500).trim();
      if (!text) return;
      // admin commands by nickname === 'admin'
      if (nickname === 'admin' && text.startsWith('/')) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const target = parts[1];
        if (cmd === '/ban' && target) {
          addBan.run(target, 'banned by admin');
          for (const [c, n] of clients.entries()) if (n === target) { sendTo(c, { type: 'banned', nickname: target }); c.close(); }
          broadcast({ type: 'system', text: `${target} is banned` });
          return;
        }
        if (cmd === '/bro' && target) {
          removeBan.run(target);
          broadcast({ type: 'system', text: `${target} is unbanned` });
          return;
        }
      }
      const player = findPlayer.get(nickname);
      const icon = player ? player.icon : null;
      insertChat.run({ nickname, icon, text, ts: Math.floor(Date.now() / 1000) });
      const msg = { type: 'chat', nickname, icon, text, ts: Date.now() };
      broadcast(msg);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastPlayersAndRanks();
  });
});

setInterval(() => {
  const rows = db.prepare('SELECT nickname, auto_per_sec FROM players WHERE auto_per_sec > 0').all();
  for (const r of rows) {
    if (r.auto_per_sec > 0) updatePlayerAfterAuto.run({ val: r.auto_per_sec, nickname: r.nickname });
  }
  broadcastPlayersAndRanks();
}, 1000);

function broadcastPlayersAndRanks() {
  const ranks = getTopRank.all();
  const players = listPlayers.all();
  broadcast({ type: 'ranks', ranks, players });
}

if (process.argv[2] === 'migrate') { console.log('migrate done'); process.exit(0); }

server.listen(PORT, () => console.log('Server listening on', PORT));
