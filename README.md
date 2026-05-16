# КАЧОК 2026 — Game Server

WebSocket сервер для гри КАЧОК 2026 (Telegram Mini App)

## Функції
- 💬 Реальний чат між гравцями (загальний + клановий)
- 🏆 Онлайн рейтинг гравців
- 🥊 PvP матчмейкінг
- 👥 Реферальна система
- 🤖 Telegram бот (/start, /top, /stats)

## Деплой на Railway (5 хвилин)

### 1. Завантаж на GitHub
- Створи репозиторій `kachok-server` на GitHub
- Завантаж всі файли (index.js, package.json, README.md)

### 2. Деплой на Railway
1. Зайди на [railway.app](https://railway.app)
2. Натисни **"New Project"**
3. Обери **"Deploy from GitHub repo"**
4. Обери репозиторій `kachok-server`
5. Railway автоматично задеплоїть сервер

### 3. Додай токен бота
1. В Railway відкрий свій проект
2. Натисни **"Variables"**
3. Додай змінну:
   ```
   BOT_TOKEN = твій_токен_від_botfather
   GAME_URL = https://твій-сайт.com
   ```
4. Railway автоматично перезапустить сервер

### 4. Отримай WebSocket URL
Після деплою Railway дасть URL виду:
```
kachok-server-production.up.railway.app
```
WebSocket URL буде:
```
wss://kachok-server-production.up.railway.app
```

### 5. Встав URL в гру
В файлі гри знайди рядок:
```javascript
const WS_URL = 'wss://your-server.railway.app';
```
Заміни на свій URL від Railway.

## Локальний запуск (для тесту)
```bash
npm install
BOT_TOKEN=твій_токен node index.js
```

## API Endpoints
- `GET /` — статус сервера
- `GET /api/leaderboard` — топ гравців
- `GET /api/stats` — статистика
- `POST /api/player` — зберегти дані гравця
- `GET /api/player/:userId` — отримати дані гравця

## WebSocket Events

### Клієнт → Сервер
```json
{ "type": "message", "room": "global", "text": "Привіт!" }
{ "type": "update", "lv": 5, "mu": 150, "rt": 1200 }
{ "type": "join_clan", "clanName": "БЕРСЕРКИ" }
{ "type": "fight_request", "rt": 1200 }
{ "type": "get_leaderboard" }
{ "type": "register_referral", "code": "KACH1A2B3" }
```

### Сервер → Клієнт
```json
{ "type": "welcome", "userId": "123", "online": 42 }
{ "type": "history", "room": "global", "messages": [...] }
{ "type": "message", "name": "IronMax", "text": "Привіт!", "ts": 1234567890 }
{ "type": "online", "count": 42 }
{ "type": "leaderboard", "players": [...] }
{ "type": "fight_found", "opponent": { "name": "Max", "lv": 5 } }
```
