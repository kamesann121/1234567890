const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { nanoid } = require('nanoid');
const _ = require('lodash');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
}

try {
  fs.mkdirSync(ICON_DIR, { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
}

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, {}); // ← 初期データを渡すように修正！

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/icons', express.static(ICON_DIR));

const upload = multer({ dest: ICON_DIR, limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/upload-icon', upload.single('icon'), async (req, res) => {
  await db.read();
  const nickname = req.body.nickname;
  if (!nickname || !req.file) return res.status(400).json({ ok: false });

  const ext = path.extname(req.file.originalname);
  const newName = `${Date.now()}-${nanoid(6)}${ext}`;
  const dst = path.join(ICON_DIR, newName);
  fs.renameSync(req.file.path, dst);
  const iconUrl = `/icons/${newName}`;

  const user = db.data.players.find(p => p.nickname === nickname);
  if (user) user.icon = iconUrl;
  else db.data.players.push({ nickname, coins: 0, tapValue: 1, auto: 0, taps: 0, icon: iconUrl });

  await db.write();
  res.json({ ok: true, icon: iconUrl });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // ws -> nickname

(async () => {
  await db.read();
  db.data ||= {
    players: [],
    bans: [],
    chat: [],
    shop: [
      { id: 'cheapUp', name: 'タップ力 +1', price: 10, type: 'tap', value: 1 },
      { id: 'midUp', name: 'タップ力 +5', price: 45, type: 'tap', value: 5 },
      { id: 'auto1', name: '自動収入 +1/s', price: 30, type: 'auto', value: 1 },
      { id: 'auto5', name: '自動収入 +5/s', price: 130, type: 'auto', value: 5 }
    ]
  };
  await db.write();

  wss.on('connection', (ws) => {
    clients.set(ws, null);

    const ranks = _.orderBy(db.data.players, ['taps'], ['desc']).slice(0, 100);
    const chats = db.data.chat.slice(-100);
    ws.send(JSON.stringify({ type: 'init', shop: db.data.shop, ranks, chats }));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      await db.read();

      if (msg.type === 'setName') {
        const nickname = msg.nickname.trim();
        if (!nickname) return ws.send(JSON.stringify({ type: 'setNameResult', ok: false, reason: 'empty' }));
        if (nickname.toLowerCase() === 'admin' && msg.adminToken !== ADMIN_TOKEN)
          return ws.send(JSON.stringify({ type: 'setNameResult', ok: false, reason: 'admin_auth' }));
        if (db.data.bans.includes(nickname))
          return ws.send(JSON.stringify({ type: 'setNameResult', ok: false, reason: 'banned' }));
        if (clients.has(ws) && Array.from(clients.values()).includes(nickname))
          return ws.send(JSON.stringify({ type: 'setNameResult', ok: false, reason: 'inuse' }));

        let user = db.data.players.find(p => p.nickname === nickname);
        if (!user) {
          user = { nickname, coins: 0, tapValue: 1, auto: 0, taps: 0, icon: null };
          db.data.players.push(user);
        }
        clients.set(ws, nickname);
        await db.write();
        ws.send(JSON.stringify({ type: 'setNameResult', ok: true, nickname }));
        broadcastRanks();
        return;
      }

      const nickname = clients.get(ws);
      if (!nickname) return;

      const user = db.data.players.find(p => p.nickname === nickname);
      if (!user) return;

      if (msg.type === 'tap') {
        user.coins += user.tapValue;
        user.taps += 1;
        await db.write();
        broadcast({ type: 'tap', nickname, coins: user.coins, taps: user.taps, tap_value: user.tapValue });
        return;
      }

      if (msg.type === 'buy') {
        const item = db.data.shop.find(i => i.id === msg.itemId);
        if (!item || user.coins < item.price)
          return ws.send(JSON.stringify({ type: 'buyResult', ok: false, reason: 'invalid_or_not_enough' }));

        user.coins -= item.price;
        if (item.type === 'tap') user.tapValue += item.value;
        if (item.type === 'auto') user.auto += item.value;
        await db.write();
        ws.send(JSON.stringify({ type: 'buyResult', ok: true, user }));
        broadcastRanks();
        return;
      }

      if (msg.type === 'chat') {
        const text = msg.text.trim();
        if (!text) return;

        if (nickname === 'admin' && text.startsWith('/')) {
          const [cmd, target] = text.split(/\s+/);
          if (cmd === '/ban' && target) {
            db.data.bans.push(target);
            await db.write();
            for (const [client, name] of clients.entries()) {
              if (name === target) {
                client.send(JSON.stringify({ type: 'banned', nickname: target }));
                client.close();
              }
            }
            broadcast({ type: 'system', text: `${target} is banned` });
            return;
          }
          if (cmd === '/bro' && target) {
            _.remove(db.data.bans, b => b === target);
            await db.write();
            broadcast({ type: 'system', text: `${target} is unbanned` });
            return;
          }
        }

        db.data.chat.push({ nickname, icon: user.icon, text, ts: Date.now() });
        await db.write();
        broadcast({ type: 'chat', nickname, icon: user.icon, text, ts: Date.now() });
        return;
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcastRanks();
    });
  });

  setInterval(async () => {
    await db.read();
    for (const user of db.data.players) {
      if (user.auto > 0) user.coins += user.auto;
    }
    await db.write();
    broadcastRanks();
  }, 1000);

  function broadcast(obj) {
    const str = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(str);
    }
  }

  function broadcastRanks() {
    const ranks = _.orderBy(db.data.players, ['taps'], ['desc']).slice(0, 100);
    broadcast({ type: 'ranks', ranks });
  }

  server.listen(PORT, () => console.log('Server running on', PORT));
})();
