'use strict';
/*
 * Ludo Gigante: servidor multijugador.
 * Un solo proceso Node: sirve public/index.html y acepta WebSockets en /ws.
 * Las salas viven en memoria; si el servidor se reinicia, se pierden.
 * El servidor es la autoridad del juego: el cliente solo pide "tirar" y "mover".
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const SPEED = Math.max(1, Number(process.env.LUDO_SPEED) || 1); // solo para pruebas
const ms = (n) => Math.max(1, Math.round(n / SPEED));
const TURN_MS = 40000;           // tiempo para jugar antes de que el servidor juegue por ti
const MAX_ROOMS = 300;
const ROOM_IDLE_MS = 5 * 60 * 1000;
const GOAL = 75;
const COLOR_NAMES = ['Rojo', 'Verde', 'Amarillo', 'Azul'];
const STARTS = [1, 18, 35, 52];
const SAFE = new Set([1, 18, 35, 52, 9, 26, 43, 60]);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const cellIdx = (k, p) => (p >= 1 && p <= 67 ? (STARTS[k] + p - 1) % 68 : -1);

const players = new Map(); // pid -> {pid,name,ws,room,offlineAt}
const rooms = new Map();   // code -> room

/* ---------- utilidades ---------- */
const online = (p) => !!(p && p.ws && p.ws.readyState === 1);
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return s || 'Jugador';
}
function newCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; } while (rooms.has(c));
  return c;
}
const mkSeat = () => ({ kind: 'empty', pid: null, name: '', misses: 0 });
const seatOf = (room, pid) => room.seats.findIndex((s) => s.kind === 'human' && s.pid === pid);
const hostSeat = (room) => seatOf(room, room.host);
const humanCount = (room) => room.seats.filter((s) => s.kind === 'human').length;
const occupied = (room) => room.seats.filter((s) => s.kind !== 'empty').length;

/* ---------- difusión ---------- */
function snapshot(room, pid) {
  const g = room.game;
  return {
    t: 'room', code: room.code, name: room.name, status: room.status, isPublic: room.isPublic,
    host: hostSeat(room), you: seatOf(room, pid),
    seats: room.seats.map((s) => ({
      kind: s.kind, name: s.name,
      online: s.kind === 'human' ? online(players.get(s.pid)) : true,
    })),
    game: g ? {
      gid: g.gid, active: g.active, pos: g.pos, turn: g.turn, phase: g.phase,
      roll: g.roll, rollSeq: g.rollSeq, opts: g.opts, last: g.last, seq: g.seq,
      msg: g.msg, winner: g.winner,
      left: g.deadline ? Math.max(0, g.deadline - Date.now()) : 0,
    } : null,
  };
}
function push(room) {
  for (const s of room.seats) {
    if (s.kind !== 'human') continue;
    const p = players.get(s.pid);
    if (online(p)) send(p.ws, snapshot(room, s.pid));
  }
}
function listRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (!r.isPublic || r.status !== 'lobby') continue;
    if (!r.seats.some((s) => s.kind === 'empty')) continue;
    out.push({ code: r.code, name: r.name, n: occupied(r) });
  }
  return out.slice(0, 50);
}
let listTimer = null;
function broadcastRooms() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = { t: 'rooms', rooms: listRooms() };
    for (const p of players.values()) if (!p.room && online(p)) send(p.ws, msg);
  }, 200);
}

/* ---------- reglas ---------- */
function options(g, k, v) {
  const o = []; let yard = false;
  g.pos[k].forEach((p, j) => {
    if (p === 0) { if (v === 6 && !yard) { o.push(j); yard = true; } }
    else if (p + v <= GOAL) o.push(j);
  });
  return o;
}
function capCount(g, k, np) {
  const idx = cellIdx(k, np);
  if (idx < 0 || SAFE.has(idx)) return 0;
  let n = 0;
  for (let o = 0; o < 4; o++) {
    if (o === k || !g.active[o]) continue;
    for (const q of g.pos[o]) if (cellIdx(o, q) === idx) n++;
  }
  return n;
}
function danger(g, idx, k) {
  if (idx < 0 || SAFE.has(idx)) return false;
  for (let o = 0; o < 4; o++) {
    if (o === k || !g.active[o]) continue;
    for (const q of g.pos[o]) {
      const gi = cellIdx(o, q);
      if (gi < 0) continue;
      const d = (idx - gi + 68) % 68;
      if (d >= 1 && d <= 6) return true;
    }
  }
  return false;
}
function cpuPick(g, k, v, opts) {
  let best = opts[0], bs = -1e9;
  for (const j of opts) {
    const p = g.pos[k][j], np = p === 0 ? 1 : p + v, idx = cellIdx(k, np);
    let s = Math.random() * 3;
    if (np === GOAL) s += 100;
    const cc = capCount(g, k, np); if (cc > 0) s += 80 + 10 * cc;
    if (p === 0) s += 45;
    if (idx >= 0 && SAFE.has(idx)) s += 18;
    if (np > 67 && p <= 67) s += 25;
    const cur = cellIdx(k, p);
    if (cur >= 0 && danger(g, cur, k)) s += 22;
    if (idx >= 0 && danger(g, idx, k)) s -= 18;
    s += np / 12;
    if (s > bs) { bs = s; best = j; }
  }
  return best;
}

/* ---------- flujo de la partida ---------- */
function schedule(room, delay, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { room.timer = null; if (rooms.get(room.code) === room) fn(); }, delay);
}
function startGame(room) {
  room.status = 'playing';
  room.gid += 1;
  room.seats.forEach((s) => { s.misses = 0; });
  const active = room.seats.map((s) => s.kind !== 'empty');
  room.game = {
    gid: room.gid, active, pos: [0, 1, 2, 3].map(() => [0, 0, 0, 0]),
    turn: active.indexOf(true), phase: 'roll', roll: 0, rollSeq: 0, sixes: 0,
    opts: [], last: null, seq: 0, msg: '', winner: -1, deadline: 0,
  };
  beginTurn(room, false);
}
function beginTurn(room, again) {
  const g = room.game;
  g.phase = 'roll'; g.opts = [];
  g.msg = again ? `¡${COLOR_NAMES[g.turn]} tira otra vez!` : `Turno de ${COLOR_NAMES[g.turn]}.`;
  armTurn(room);
  push(room);
}
function nextTurn(room) {
  const g = room.game;
  let t = g.turn;
  do { t = (t + 1) % 4; } while (!g.active[t]);
  g.turn = t; g.sixes = 0;
  beginTurn(room, false);
}
// Decide quién actúa: un humano conectado tiene TURN_MS; una CPU o un humano desconectado juega enseguida.
function armTurn(room) {
  const g = room.game;
  if (!g || room.status !== 'playing') return;
  if (g.phase !== 'roll' && g.phase !== 'move') return;
  const seat = room.seats[g.turn];
  const live = seat.kind === 'human' && online(players.get(seat.pid));
  g.deadline = live ? Date.now() + TURN_MS : 0;
  const delay = live ? TURN_MS : (g.phase === 'roll' ? ms(900) : ms(1000));
  schedule(room, delay, () => autoAct(room, live));
}
function convertToCpu(room, idx) {
  const s = room.seats[idx];
  s.kind = 'cpu'; s.pid = null; s.name = (s.name || 'CPU').slice(0, 8) + ' (CPU)'; s.misses = 0;
}
function autoAct(room, timedOut) {
  const g = room.game;
  if (!g || room.status !== 'playing') return;
  const k = g.turn, seat = room.seats[k];
  if (timedOut && seat.kind === 'human') {
    seat.misses += 1;
    if (seat.misses >= 3) {
      const p = players.get(seat.pid);
      if (p) { p.room = null; send(p.ws, { t: 'left', why: 'Saliste de la partida por inactividad.' }); send(p.ws, { t: 'rooms', rooms: listRooms() }); }
      convertToCpu(room, k);
      afterLeave(room);
      if (!rooms.has(room.code)) return;
    }
  }
  if (g.phase === 'roll') doRoll(room);
  else if (g.phase === 'move') applyMove(room, cpuPick(g, k, g.roll, g.opts));
}
function doRoll(room) {
  const g = room.game;
  if (g.phase !== 'roll') return;
  const k = g.turn, v = 1 + crypto.randomInt(6), cname = COLOR_NAMES[k];
  g.roll = v; g.rollSeq += 1; g.last = null; g.deadline = 0;
  if (v === 6) g.sixes += 1; else g.sixes = 0;
  if (g.sixes === 3) {
    g.phase = 'wait'; g.opts = []; g.sixes = 0;
    g.msg = `Tres 6 seguidos: ${cname} pierde el turno.`;
    push(room); schedule(room, ms(1700), () => nextTurn(room)); return;
  }
  const opts = options(g, k, v);
  g.opts = opts;
  if (!opts.length) {
    g.phase = 'wait'; g.msg = `Salió un ${v}: ${cname} no puede mover.`;
    push(room); schedule(room, ms(1500), () => nextTurn(room)); return;
  }
  if (opts.length === 1) {
    g.phase = 'wait'; g.msg = `Salió un ${v}.`;
    push(room); schedule(room, ms(1000), () => applyMove(room, opts[0])); return;
  }
  g.phase = 'move'; g.msg = `Salió un ${v}.`;
  armTurn(room);
  push(room);
}
function applyMove(room, j) {
  const g = room.game, k = g.turn, v = g.roll;
  if (!g.opts.includes(j)) return;
  const from = g.pos[k][j], to = from === 0 ? 1 : from + v;
  g.pos[k][j] = to;
  const captured = [];
  if (to <= 67) {
    const idx = cellIdx(k, to);
    if (!SAFE.has(idx)) {
      for (let o = 0; o < 4; o++) {
        if (o === k || !g.active[o]) continue;
        for (let n = 0; n < 4; n++) {
          if (cellIdx(o, g.pos[o][n]) === idx) { captured.push([o, n]); g.pos[o][n] = 0; }
        }
      }
    }
  }
  g.seq += 1; g.last = { k, i: j, from, to, captured }; g.opts = []; g.deadline = 0;
  const cname = COLOR_NAMES[k];
  if (g.pos[k].every((x) => x === GOAL)) {
    g.phase = 'over'; g.winner = k; g.msg = `¡Gana ${cname}!`; room.status = 'over';
    clearTimeout(room.timer); room.timer = null;
    push(room); broadcastRooms(); return;
  }
  const extra = v === 6 || captured.length > 0 || to === GOAL;
  g.msg = captured.length
    ? `¡${cname} captura ${captured.length} ficha${captured.length > 1 ? 's' : ''}!`
    : (to === GOAL ? '¡Una ficha llegó al centro!' : '');
  g.phase = 'wait';
  const steps = from === 0 ? 1 : v;
  const dur = ms(steps * 150 + (from === 0 ? 300 : 0) + 500 + (captured.length ? 700 : 0));
  push(room);
  schedule(room, dur, () => (extra ? beginTurn(room, true) : nextTurn(room)));
}

/* ---------- salas ---------- */
function joinRoom(p, room, wantSeat) {
  if (room.status !== 'lobby') return 'La partida ya empezó.';
  let idx = -1;
  if (Number.isInteger(wantSeat) && wantSeat >= 0 && wantSeat < 4 && room.seats[wantSeat].kind === 'empty') idx = wantSeat;
  else idx = room.seats.findIndex((s) => s.kind === 'empty');
  if (idx < 0) return 'La sala está llena.';
  room.seats[idx] = { kind: 'human', pid: p.pid, name: p.name, misses: 0 };
  p.room = room.code;
  return null;
}
function destroyRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
  for (const s of room.seats) {
    if (s.kind !== 'human') continue;
    const p = players.get(s.pid);
    if (p && p.room === room.code) p.room = null;
  }
  broadcastRooms();
}
function afterLeave(room) {
  if (humanCount(room) === 0) { destroyRoom(room); return; }
  if (seatOf(room, room.host) < 0) room.host = room.seats.find((s) => s.kind === 'human').pid;
  if (room.status === 'playing' && room.game) armTurn(room);
  push(room);
  broadcastRooms();
}
function leaveRoom(p) {
  const room = rooms.get(p.room);
  p.room = null;
  if (!room) return;
  const i = seatOf(room, p.pid);
  if (i >= 0) {
    if (room.status === 'playing') convertToCpu(room, i);
    else room.seats[i] = mkSeat();
  }
  afterLeave(room);
}
function onClose(p, ws) {
  if (p.ws !== ws) return;
  p.ws = null; p.offlineAt = Date.now();
  const room = rooms.get(p.room);
  if (!room) return;
  if (room.status === 'playing') {
    if (room.game) armTurn(room);
    push(room);
  } else {
    push(room);
    setTimeout(() => { if (!online(p) && p.room === room.code) leaveRoom(p); }, 30000).unref();
  }
}

/* ---------- mensajes ---------- */
function err(p, msg) { send(p.ws, { t: 'err', msg }); }
function handle(p, m) {
  const room = rooms.get(p.room);
  switch (m.t) {
    case 'list':
      send(p.ws, { t: 'rooms', rooms: listRooms() });
      break;
    case 'create': {
      if (room) return err(p, 'Ya estás en una sala.');
      if (rooms.size >= MAX_ROOMS) return err(p, 'Hay demasiadas salas ahora mismo. Prueba en un rato.');
      p.name = cleanName(m.name);
      const r = {
        code: newCode(), name: `Sala de ${p.name}`, isPublic: m.pub !== false, host: p.pid,
        status: 'lobby', seats: [mkSeat(), mkSeat(), mkSeat(), mkSeat()], game: null,
        timer: null, gid: 0, lastOnline: Date.now(),
      };
      rooms.set(r.code, r);
      joinRoom(p, r, 0);
      push(r); broadcastRooms();
      break;
    }
    case 'join': {
      if (room) return err(p, 'Ya estás en una sala.');
      const r = rooms.get(String(m.code || '').toUpperCase().slice(0, 4));
      if (!r) return err(p, 'No existe una sala con ese código.');
      p.name = cleanName(m.name);
      const e = joinRoom(p, r, m.seat);
      if (e) return err(p, e);
      push(r); broadcastRooms();
      break;
    }
    case 'sit': {
      if (!room || room.status !== 'lobby') return;
      const idx = m.seat, cur = seatOf(room, p.pid);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3 || room.seats[idx].kind !== 'empty' || cur < 0) return;
      room.seats[idx] = room.seats[cur]; room.seats[cur] = mkSeat();
      push(room);
      break;
    }
    case 'seat': { // el anfitrión agrega o quita CPU, o expulsa
      if (!room || room.status !== 'lobby' || room.host !== p.pid) return;
      const idx = m.seat;
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
      const s = room.seats[idx];
      if (m.kind === 'cpu' && s.kind === 'empty') {
        room.seats[idx] = { kind: 'cpu', pid: null, name: 'CPU', misses: 0 };
      } else if (m.kind === 'empty' && s.kind === 'cpu') {
        room.seats[idx] = mkSeat();
      } else if (m.kind === 'empty' && s.kind === 'human' && s.pid !== p.pid) {
        const kicked = players.get(s.pid);
        room.seats[idx] = mkSeat();
        if (kicked) {
          kicked.room = null;
          send(kicked.ws, { t: 'left', why: 'El anfitrión te sacó de la sala.' });
          send(kicked.ws, { t: 'rooms', rooms: listRooms() });
        }
      } else return;
      push(room); broadcastRooms();
      break;
    }
    case 'start':
      if (!room || room.status !== 'lobby' || room.host !== p.pid) return;
      if (occupied(room) < 2) return err(p, 'Se necesitan al menos 2 jugadores.');
      startGame(room);
      broadcastRooms();
      break;
    case 'rematch': {
      if (!room || room.status !== 'over' || room.host !== p.pid) return;
      room.status = 'lobby'; room.game = null;
      clearTimeout(room.timer); room.timer = null;
      room.seats.forEach((s, i) => {
        if (s.kind === 'human' && !online(players.get(s.pid))) {
          const gone = players.get(s.pid); if (gone) gone.room = null;
          room.seats[i] = mkSeat();
        }
      });
      afterLeave(room);
      break;
    }
    case 'leave':
      leaveRoom(p);
      send(p.ws, { t: 'left' });
      send(p.ws, { t: 'rooms', rooms: listRooms() });
      break;
    case 'roll': {
      if (!room || room.status !== 'playing') return;
      const g = room.game, k = seatOf(room, p.pid);
      if (k < 0 || k !== g.turn || g.phase !== 'roll') return;
      room.seats[k].misses = 0;
      clearTimeout(room.timer); room.timer = null;
      doRoll(room);
      break;
    }
    case 'move': {
      if (!room || room.status !== 'playing') return;
      const g = room.game, k = seatOf(room, p.pid);
      if (k < 0 || k !== g.turn || g.phase !== 'move') return;
      let j = Number(m.i);
      if (!Number.isInteger(j) || j < 0 || j > 3) return;
      if (g.pos[k][j] === 0) { // las fichas en casa son equivalentes
        const y = g.opts.find((o) => g.pos[k][o] === 0);
        if (y === undefined) return;
        j = y;
      }
      if (!g.opts.includes(j)) return;
      room.seats[k].misses = 0;
      clearTimeout(room.timer); room.timer = null;
      applyMove(room, j);
      break;
    }
    default:
  }
}

/* ---------- HTTP + WebSocket ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    });
    res.end(INDEX);
  } else if (url === '/favicon.ico') {
    res.writeHead(204); res.end();
  } else if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: players.size }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  let p = null, tokens = 30;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const refill = setInterval(() => { tokens = 30; }, 2000);
  ws.on('message', (data) => {
    if (--tokens < 0) { ws.close(1008, 'demasiados mensajes'); return; }
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const pid = typeof m.pid === 'string' && /^[a-f0-9]{16,48}$/.test(m.pid) ? m.pid : crypto.randomBytes(12).toString('hex');
      p = players.get(pid);
      if (!p) { p = { pid, name: cleanName(m.name), ws: null, room: null, offlineAt: 0 }; players.set(pid, p); }
      if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'otra pestaña'); } catch (e) { /* nada */ } }
      p.ws = ws;
      send(ws, { t: 'welcome', pid, name: p.name });
      const room = rooms.get(p.room);
      if (room && seatOf(room, pid) >= 0) {
        if (room.game && room.status === 'playing') armTurn(room);
        push(room);
      } else {
        p.room = null;
        send(ws, { t: 'rooms', rooms: listRooms() });
      }
      return;
    }
    if (!p) return;
    try { handle(p, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => { clearInterval(refill); if (p) onClose(p, ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 25000).unref();

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const any = room.seats.some((s) => s.kind === 'human' && online(players.get(s.pid)));
    if (any) room.lastOnline = now;
    else if (now - room.lastOnline > ROOM_IDLE_MS) destroyRoom(room);
  }
  for (const [pid, p] of players) {
    if (!online(p) && !p.room && now - (p.offlineAt || 0) > 10 * 60 * 1000) players.delete(pid);
  }
}, 30000).unref();

server.listen(PORT, () => console.log(`Ludo Gigante escuchando en el puerto ${PORT}`));
