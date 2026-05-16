const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');

// ─────────────────────────────────────────
// CONFIG  (замінити на свої значення)
// ─────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || 'ТВІЙ_ТОКЕН_СЮДИ';
const PORT      = process.env.PORT || 3000;
const GAME_URL  = process.env.GAME_URL || 'https://morensomarks.github.io/kachok2026';

// ─────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    game:   'КАЧОК 2026',
    players: wss ? wss.clients.size : 0,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ─────────────────────────────────────────
// IN-MEMORY STORAGE
// (замінити на Supabase/PostgreSQL пізніше)
// ─────────────────────────────────────────

// Leaderboard: { userId: { name, lv, mu, rt, weekRt, coins } }
const players = new Map();

// Chat history: last 100 messages per room
const chatHistory = {
  global: [],
  // clan rooms: 'clan_НАЗВА': []
};

// Online clients: { ws: { userId, name, lv, room } }
const clients = new Map();

// Referral codes: { code: userId }
const referrals = new Map();

function addToHistory(room, msg) {
  if (!chatHistory[room]) chatHistory[room] = [];
  chatHistory[room].push(msg);
  if (chatHistory[room].length > 100) chatHistory[room].shift();
}

function getOnlineCount(room) {
  let count = 0;
  clients.forEach(c => { if (!room || c.room === room || room === 'global') count++; });
  return count;
}

// ─────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const userId = url.searchParams.get('userId') || 'guest_' + Date.now();
  const name   = decodeURIComponent(url.searchParams.get('name') || 'Гравець');
  const lv     = parseInt(url.searchParams.get('lv') || '0');
  const token  = url.searchParams.get('token') || '';

  // Save client info
  clients.set(ws, { userId, name, lv, room: 'global' });

  console.log(`[+] ${name} (${userId}) connected | total: ${wss.clients.size}`);

  // Send welcome + history
  safeSend(ws, {
    type: 'welcome',
    userId,
    online: getOnlineCount(),
  });

  safeSend(ws, {
    type: 'history',
    room: 'global',
    messages: chatHistory.global.slice(-50),
  });

  // Broadcast online count update
  broadcastOnline();

  // ── Handle incoming messages ──
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const client = clients.get(ws);
      if (!client) return;

      switch (msg.type) {

        // ── Chat message ──
        case 'message': {
          const text = String(msg.text || '').slice(0, 300).trim();
          if (!text) break;

          const room = msg.room || 'global';
          const chatMsg = {
            type:   'message',
            room,
            userId: client.userId,
            name:   client.name,
            lv:     client.lv,
            text,
            ts:     Date.now(),
            avatar: msg.avatar || '💪',
          };

          addToHistory(room, chatMsg);
          broadcastToRoom(room, chatMsg, ws);
          safeSend(ws, chatMsg); // echo back to sender
          break;
        }

        // ── Update player data ──
        case 'update': {
          const client = clients.get(ws);
          if (!client) break;
          client.lv = msg.lv || client.lv;
          players.set(client.userId, {
            name:   client.name,
            lv:     msg.lv   || 0,
            mu:     msg.mu   || 0,
            rt:     msg.rt   || 0,
            weekRt: msg.weekRt || 0,
            coins:  msg.coins  || 0,
            ts:     Date.now(),
          });
          break;
        }

        // ── Join clan room ──
        case 'join_clan': {
          const clanRoom = 'clan_' + (msg.clanName || '').replace(/\s/g, '_');
          client.room = clanRoom;
          clients.set(ws, client);
          if (!chatHistory[clanRoom]) chatHistory[clanRoom] = [];
          safeSend(ws, {
            type: 'history',
            room: clanRoom,
            messages: chatHistory[clanRoom].slice(-50),
          });
          break;
        }

        // ── Fight request (PvP matchmaking) ──
        case 'fight_request': {
          const opponent = findOpponent(ws, msg.rt || 0);
          if (opponent) {
            const oppClient = clients.get(opponent);
            safeSend(ws, {
              type: 'fight_found',
              opponent: { name: oppClient.name, lv: oppClient.lv }
            });
          } else {
            safeSend(ws, { type: 'fight_wait' });
          }
          break;
        }

        // ── Fight result ──
        case 'fight_result': {
          const client = clients.get(ws);
          if (!client) break;
          const p = players.get(client.userId) || {};
          p.rt = (p.rt || 0) + (msg.ratingChange || 0);
          players.set(client.userId, p);
          // Broadcast leaderboard update
          broadcastLeaderboard();
          break;
        }

        // ── Get leaderboard ──
        case 'get_leaderboard': {
          safeSend(ws, {
            type: 'leaderboard',
            players: getLeaderboard(),
          });
          break;
        }

        // ── Referral ──
        case 'referral_use': {
          const code = msg.code || '';
          const ownerId = referrals.get(code);
          if (ownerId && ownerId !== client.userId) {
            safeSend(ws, { type: 'referral_ok', bonus: 50 });
            // Notify referral owner
            clients.forEach((c, ownerWs) => {
              if (c.userId === ownerId) {
                safeSend(ownerWs, { type: 'referral_used', bonus: 100, by: client.name });
              }
            });
          }
          break;
        }

        case 'register_referral': {
          if (msg.code) referrals.set(msg.code, client.userId);
          break;
        }

      }
    } catch (e) {
      console.error('WS parse error:', e.message);
    }
  });

  // ── Disconnect ──
  ws.on('close', () => {
    const client = clients.get(ws);
    console.log(`[-] ${client?.name || 'Unknown'} disconnected | total: ${wss.clients.size - 1}`);
    clients.delete(ws);
    broadcastOnline();
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch (e) {}
}

function broadcastToRoom(room, data, excludeWs = null) {
  clients.forEach((client, ws) => {
    if (ws === excludeWs) return;
    if (room === 'global' || client.room === room) {
      safeSend(ws, data);
    }
  });
}

function broadcastOnline() {
  const count = wss.clients.size;
  const msg = { type: 'online', count };
  clients.forEach((_, ws) => safeSend(ws, msg));
}

function broadcastLeaderboard() {
  const lb = { type: 'leaderboard', players: getLeaderboard() };
  clients.forEach((_, ws) => safeSend(ws, lb));
}

function getLeaderboard() {
  return Array.from(players.entries())
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.rt || 0) - (a.rt || 0))
    .slice(0, 50);
}

function findOpponent(ws, rt) {
  let best = null, bestDiff = Infinity;
  clients.forEach((client, owWs) => {
    if (owWs === ws) return;
    const p = players.get(client.userId);
    const diff = Math.abs((p?.rt || 0) - rt);
    if (diff < bestDiff) { bestDiff = diff; best = owWs; }
  });
  return bestDiff < 500 ? best : null;
}

// ─────────────────────────────────────────
// REST API
// ─────────────────────────────────────────

// Leaderboard API
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// Save player data
app.post('/api/player', (req, res) => {
  const { userId, name, lv, mu, rt, weekRt, coins } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  players.set(userId, { name, lv, mu, rt, weekRt, coins, ts: Date.now() });
  res.json({ ok: true });
});

// Get player data
app.get('/api/player/:userId', (req, res) => {
  const p = players.get(req.params.userId);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

// Online stats
app.get('/api/stats', (req, res) => {
  res.json({
    online: wss.clients.size,
    totalPlayers: players.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────
// TELEGRAM BOT
// ─────────────────────────────────────────
if (BOT_TOKEN !== 'ТВІЙ_ТОКЕН_СЮДИ') {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });

    bot.onText(/\/start(.*)/, (msg, match) => {
      const chatId  = msg.chat.id;
      const refCode = (match[1] || '').trim();
      const name    = msg.from.first_name || 'Гравець';

      const keyboard = {
        inline_keyboard: [[{
          text: '🏋️ Грати в КАЧОК 2026',
          web_app: { url: GAME_URL + (refCode ? `?ref=${refCode}` : '') }
        }]]
      };

      bot.sendMessage(chatId,
        `👋 Привіт, ${name}!\n\n` +
        `💪 Ласкаво просимо до *КАЧОК 2026*!\n\n` +
        `🏋️ Качай м'язи\n` +
        `🥊 Бийся з гравцями\n` +
        `⚔️ Вступай у клани\n` +
        `🏆 Ставай чемпіоном!\n\n` +
        (refCode ? `🎁 Тебе запросив друг — ти отримаєш +50 монет!\n\n` : '') +
        `Натисни кнопку нижче щоб почати:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    });

    bot.onText(/\/help/, (msg) => {
      bot.sendMessage(msg.chat.id,
        `🎮 *КАЧОК 2026 — Допомога*\n\n` +
        `🏋️ /start — Запустити гру\n` +
        `📊 /stats — Статистика серверу\n` +
        `🏆 /top — Топ 10 гравців\n`,
        { parse_mode: 'Markdown' }
      );
    });

    bot.onText(/\/stats/, async (msg) => {
      const text =
        `📊 *Статистика КАЧОК 2026*\n\n` +
        `👥 Онлайн: ${wss.clients.size}\n` +
        `🎮 Всього гравців: ${players.size}\n` +
        `⏱ Uptime: ${Math.floor(process.uptime()/60)} хв`;
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/top/, (msg) => {
      const lb = getLeaderboard().slice(0, 10);
      if (!lb.length) {
        bot.sendMessage(msg.chat.id, '🏆 Поки немає гравців у рейтингу!');
        return;
      }
      const medals = ['🥇','🥈','🥉'];
      const text = '🏆 *Топ 10 гравців*\n\n' +
        lb.map((p, i) =>
          `${medals[i]||`${i+1}.`} *${p.name}* — ${p.rt} очок (Рів.${p.lv})`
        ).join('\n');
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    console.log('✅ Telegram bot started');
  } catch (e) {
    console.error('Bot error:', e.message);
  }
}

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║     КАЧОК 2026 — Game Server      ║
╠═══════════════════════════════════╣
║  Port:    ${PORT}                      ║
║  WS:      ws://localhost:${PORT}       ║
║  Status:  Running ✅               ║
╚═══════════════════════════════════╝
  `);
});
