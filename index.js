const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');

const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const PORT         = process.env.PORT         || 3000;
const GAME_URL     = process.env.GAME_URL     || 'https://MorensoMaks.github.io/kachok2026';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iudewuslbckvymdabwwx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

async function sb(table, method='GET', body=null, query=''){
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer '+SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method==='POST'?'return=representation,resolution=merge-duplicates':'',
    },
  };
  if(body) opts.body = JSON.stringify(body);
  try{
    const r = await fetch(url, opts);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }catch(e){ console.error('[SB]',e.message); return null; }
}

async function upsertPlayer(data){
  return sb('players','POST',data,'?on_conflict=id');
}
async function getMessages(room,limit=50){
  const r = await sb('messages','GET',null,`?room=eq.${encodeURIComponent(room)}&order=ts.desc&limit=${limit}`);
  return (r||[]).reverse();
}
async function saveMsg(msg){
  return sb('messages','POST',msg);
}
async function getLeaderboard(limit=50){
  return sb('players','GET',null,`?order=rt.desc&limit=${limit}&select=id,name,lv,mu,rt,week_rt`)||[];
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({server});

app.use(cors());
app.use(express.json());

const clients   = new Map();
const chatCache = {};

app.get('/', (req,res) => res.json({status:'ok',game:'КАЧОК 2026',players:clients.size,uptime:Math.floor(process.uptime())+'s'}));
app.get('/api/leaderboard', async (req,res) => res.json(await getLeaderboard()));
app.get('/api/stats', (req,res) => res.json({online:clients.size,uptime:Math.floor(process.uptime())}));

wss.on('connection', async (ws, req) => {
  const url    = new URL(req.url,'http://localhost');
  const userId = url.searchParams.get('userId')||'guest_'+Date.now();
  const name   = decodeURIComponent(url.searchParams.get('name')||'Гравець');
  const lv     = parseInt(url.searchParams.get('lv')||'0');

  clients.set(ws,{userId,name,lv,room:'global'});
  console.log(`[+] ${name} | online: ${clients.size}`);

  safeSend(ws,{type:'welcome',userId,online:clients.size});

  if(!chatCache['global']) chatCache['global'] = await getMessages('global',50);
  safeSend(ws,{type:'history',room:'global',messages:chatCache['global']});
  broadcastOnline();

  ws.on('message', async data => {
    try{
      const msg = JSON.parse(data.toString());
      const c = clients.get(ws);
      if(!c) return;

      if(msg.type==='message'){
        const text = String(msg.text||'').slice(0,300).trim();
        if(!text) return;
        const room = msg.room||'global';
        const out = {type:'message',room,user_id:c.userId,user_name:c.name,user_lv:c.lv,text,avatar:msg.avatar||'💪',ts:Date.now()};
        saveMsg({room,user_id:c.userId,user_name:c.name,user_lv:c.lv,text,avatar:out.avatar,ts:out.ts});
        if(!chatCache[room]) chatCache[room]=[];
        chatCache[room].push(out);
        if(chatCache[room].length>100) chatCache[room].shift();
        broadcastToRoom(room,out,ws);
        safeSend(ws,out);
      }

      else if(msg.type==='update'){
        c.lv=msg.lv||0;
        upsertPlayer({
          id:c.userId,name:c.name,lv:msg.lv||0,mu:msg.mu||0,
          en:msg.en||100,hp:msg.hp||100,coins:msg.coins||0,gems:msg.gems||0,
          rt:msg.rt||0,week_rt:msg.weekRt||0,wins:msg.wins||0,losses:msg.losses||0,
          skin:msg.skin||'default',train_count:msg.trainCount||0,
          daily_streak:msg.dailyStreak||0,last_daily:msg.lastDaily||0,
          ref_code:msg.refCode||null,ref_count:msg.refCount||0,last_fight:msg.lastFight||0,
        });
      }

      else if(msg.type==='join_clan'){
        const room='clan_'+String(msg.clanName||'').replace(/\s/g,'_');
        c.room=room; clients.set(ws,c);
        if(!chatCache[room]) chatCache[room]=await getMessages(room,50);
        safeSend(ws,{type:'history',room,messages:chatCache[room]});
      }

      else if(msg.type==='get_leaderboard'){
        safeSend(ws,{type:'leaderboard',players:await getLeaderboard()});
      }

      else if(msg.type==='register_referral'&&msg.code){
        upsertPlayer({id:c.userId,name:c.name,ref_code:msg.code,lv:0,mu:0,en:100,hp:100,coins:0,gems:10,rt:0,week_rt:0,wins:0,losses:0});
      }

    }catch(e){ console.error('WS err:',e.message); }
  });

  ws.on('close',()=>{ clients.delete(ws); broadcastOnline(); console.log(`[-] ${name} | online: ${clients.size}`); });
  ws.on('error',e=>console.error('WS:',e.message));
});

function safeSend(ws,data){ try{ if(ws.readyState===1) ws.send(JSON.stringify(data)); }catch(e){} }
function broadcastOnline(){ const n=clients.size; clients.forEach((_,ws)=>safeSend(ws,{type:'online',count:n})); }
function broadcastToRoom(room,data,ex){ clients.forEach((c,ws)=>{ if(ws!==ex&&(room==='global'||c.room===room)) safeSend(ws,data); }); }

if(BOT_TOKEN){
  try{
    const Bot = require('node-telegram-bot-api');
    const bot = new Bot(BOT_TOKEN,{polling:true});
    bot.onText(/\/start(.*)/,(msg,m)=>{
      const ref=(m[1]||'').trim();
      bot.sendMessage(msg.chat.id,
        `👋 Привіт, ${msg.from.first_name||'Гравець'}!\n\n💪 *КАЧОК 2026* — качай м'язи і стань чемпіоном!\n\n`+(ref?`🎁 +50 монет стартовий бонус!\n\n`:''),
        {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🏋️ Грати',web_app:{url:GAME_URL+(ref?`?ref=${ref}`:'')}}]]}}
      );
    });
    bot.onText(/\/top/,async msg=>{
      const lb=await getLeaderboard(10);
      const t=lb&&lb.length?'🏆 *Топ гравців*\n\n'+lb.map((p,i)=>`${['🥇','🥈','🥉'][i]||i+1+'.'} *${p.name}* — ${p.rt} оч. (Рів.${p.lv})`).join('\n'):'Поки немає гравців!';
      bot.sendMessage(msg.chat.id,t,{parse_mode:'Markdown'});
    });
    bot.onText(/\/stats/,msg=>bot.sendMessage(msg.chat.id,`📊 Онлайн: ${clients.size} | Uptime: ${Math.floor(process.uptime()/60)} хв`));
    console.log('✅ Bot OK');
  }catch(e){ console.error('Bot:',e.message); }
}

server.listen(PORT,()=>{
  console.log(`✅ Server :${PORT} | Supabase: ${SUPABASE_KEY?'✅':'❌ no key'}`);
});
