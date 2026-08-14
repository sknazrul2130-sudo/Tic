/**
 * Tic Tac Toe - Web Server + Online Multiplayer & Tournament Server
 * --------------------------------------------------------------------
 * Serves the game (static files in ./public) over HTTP and runs the
 * WebSocket relay for online multiplayer / tournaments on the SAME port.
 *
 * Features relayed by this server:
 *  - Quick-match 1v1 rooms (create / join with a 4-letter code)
 *  - Bracket tournaments (4 or 8 players, single elimination)
 *  - In-game chat
 *  - Animated emoji reactions
 *  - Best-of-3 round continuation within a match
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Then open http://localhost:8080 (or the port in process.env.PORT).
 * Because HTTP and WebSocket share one port, the game can auto-detect
 * the server address when it's loaded from this server directly. For a
 * separately-hosted frontend, set CONFIG.SERVER_URL inside
 * public/index.html to point at wherever this server is deployed.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Admin dashboard access key. Set this via an environment variable in any
// real deployment — the fallback below is only for quick local testing.
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
if (!process.env.ADMIN_KEY) {
  console.warn('[admin] ADMIN_KEY not set — using the default key "admin123". Set the ADMIN_KEY environment variable before deploying.');
}
const MOD_KEY = process.env.MOD_KEY || 'mod123';
if (!process.env.MOD_KEY) {
  console.warn('[mod] MOD_KEY not set — using the default key "mod123". Set the MOD_KEY environment variable before deploying.');
}

const SERVER_STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB safety cap
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

/** Returns 'admin', 'mod', or null based on the x-admin-key header. */
function keyRole(req) {
  const key = req.headers['x-admin-key'];
  if (!key) return null;
  if (key === ADMIN_KEY) return 'admin';
  if (key === MOD_KEY) return 'mod';
  return null;
}

/* ============================================================
 * Static file server + Admin API
 * ============================================================ */
const httpServer = http.createServer(async (req, res) => {
  const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'OPTIONS' && reqPath.startsWith('/admin/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  if (reqPath.startsWith('/admin/api/')) {
    handleAdminApi(req, res, reqPath);
    return;
  }

  let filePath2 = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, filePath2));

  // prevent path traversal outside the public directory
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fall back to index.html for unknown routes (simple SPA behavior)
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ============================================================
 * WebSocket game/tournament relay (attached to the same server)
 * ============================================================ */
const wss = new WebSocket.Server({ server: httpServer });

/** All currently-connected sockets, for the admin dashboard */
const clients = new Set();

/** Quick-match rooms: code -> { players:[ws,ws], rematchVotes:Set } */
const rooms = new Map();

/** Tournaments: code -> Tournament */
const tournaments = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

function genCode(len) {
  len = len || 4;
  let code;
  do {
    code = Array.from({ length: len }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code) || tournaments.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function otherPlayer(room, ws) {
  return room.players.find((p) => p !== ws);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- Tournament logic ---------- */

function createTournament(size) {
  const code = genCode(4);
  tournaments.set(code, {
    code,
    size,
    players: [],
    round: 1,
    matches: [],
    champion: null,
  });
  return code;
}

function startTournamentRound(t) {
  const active = t.players.filter((p) => !p.tEliminated);
  const shuffled = shuffle(active);
  t.matches = [];

  for (let i = 0; i < shuffled.length; i += 2) {
    const p1 = shuffled[i];
    const p2 = shuffled[i + 1];

    if (!p2) {
      t.matches.push({ code: null, players: [p1], winner: p1, bye: true });
      send(p1, { type: 't-bye', round: t.round });
      continue;
    }

    const matchCode = `${t.code}-${genCode(3)}`;
    rooms.set(matchCode, { players: [p1, p2], rematchVotes: new Set(), tournament: t.code });
    p1.roomCode = matchCode;
    p2.roomCode = matchCode;
    p1.tournament = t.code;
    p2.tournament = t.code;

    t.matches.push({ code: matchCode, players: [p1, p2], winner: null, bye: false });

    send(p1, { type: 't-match-start', room: matchCode, symbol: 'X', round: t.round, opponent: p2.name || 'Opponent' });
    send(p2, { type: 't-match-start', room: matchCode, symbol: 'O', round: t.round, opponent: p1.name || 'Opponent' });
  }

  broadcastBracket(t);
  checkRoundComplete(t);
}

function broadcastBracket(t) {
  const bracket = {
    round: t.round,
    size: t.size,
    matches: t.matches.map((m) => ({
      p1: m.players[0] ? (m.players[0].name || 'Player') : null,
      p2: !m.bye && m.players[1] ? (m.players[1].name || 'Player') : null,
      bye: m.bye,
      winner: m.winner ? (m.winner.name || 'Player') : null,
    })),
  };
  const names = t.players.map((p) => p.name || 'Player');
  t.players.forEach((p) => send(p, { type: 't-bracket', bracket }));
  t.players.forEach((p) => send(p, { type: 't-joined', room: t.code, size: t.size, count: t.players.length, names }));
}

function checkRoundComplete(t) {
  if (t.matches.length === 0) return;
  const allDone = t.matches.every((m) => m.winner);
  if (!allDone) return;

  const winners = t.matches.map((m) => m.winner).filter(Boolean);

  if (winners.length <= 1) {
    t.champion = winners[0] || null;
    t.players.forEach((p) => {
      send(p, { type: 't-champion', name: t.champion ? (t.champion.name || 'Player') : null, isMe: t.champion === p });
    });
    tournaments.delete(t.code);
    return;
  }

  t.players.forEach((p) => {
    if (!winners.includes(p)) {
      p.tEliminated = true;
      send(p, { type: 't-eliminated' });
    }
  });

  t.round += 1;
  setTimeout(() => startTournamentRound(t), 1200);
}

/* ---------- Connection handling ---------- */

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.connectedAt = Date.now();
  ws.roomCode = null;
  ws.symbol = null;
  ws.name = null;
  ws.tournament = null;
  ws.tEliminated = false;
  clients.add(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.name) ws.name = String(msg.name).slice(0, 20);

    switch (msg.type) {
      /* ---------- Quick-match 1v1 ---------- */
      case 'create': {
        const code = genCode(4);
        rooms.set(code, { players: [ws], rematchVotes: new Set() });
        ws.roomCode = code;
        ws.symbol = 'X';
        send(ws, { type: 'created', room: code });
        break;
      }

      case 'join': {
        const code = (msg.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          return;
        }
        if (room.players.length >= 2) {
          send(ws, { type: 'error', message: 'Room is full' });
          return;
        }
        room.players.push(ws);
        ws.roomCode = code;
        ws.symbol = 'O';
        send(ws, { type: 'joined', room: code, symbol: 'O' });

        const [p1, p2] = room.players;
        send(p1, { type: 'start', symbol: 'X', opponentName: p2.name || 'Opponent' });
        send(p2, { type: 'start', symbol: 'O', opponentName: p1.name || 'Opponent' });
        break;
      }

      case 'move': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const opp = otherPlayer(room, ws);
        send(opp, { type: 'opponent-move', index: msg.index, symbol: msg.symbol });
        break;
      }

      case 'round-continue': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const opp = otherPlayer(room, ws);
        send(opp, { type: 'round-continue' });
        break;
      }

      case 'chat': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text.trim()) return;
        const opp = otherPlayer(room, ws);
        send(opp, { type: 'chat', text });
        break;
      }

      case 'reaction': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const emoji = String(msg.emoji || '').slice(0, 8);
        if (!emoji) return;
        const opp = otherPlayer(room, ws);
        send(opp, { type: 'reaction', emoji });
        break;
      }

      case 'rematch': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.rematchVotes.add(ws);
        const opp = otherPlayer(room, ws);
        send(opp, { type: 'rematch-request' });
        if (opp && room.rematchVotes.has(opp)) {
          room.rematchVotes.clear();
          send(room.players[0], { type: 'rematch-start' });
          send(room.players[1], { type: 'rematch-start' });
        }
        break;
      }

      case 'leave': {
        cleanupPlayer(ws);
        break;
      }

      /* ---------- Tournament ---------- */
      case 'create-tournament': {
        const size = [4, 8].includes(msg.size) ? msg.size : 4;
        const code = createTournament(size);
        const t = tournaments.get(code);
        ws.tournament = code;
        t.players.push(ws);
        send(ws, { type: 't-created', room: code, size, count: t.players.length });
        break;
      }

      case 'join-tournament': {
        const code = (msg.room || '').toUpperCase().trim();
        const t = tournaments.get(code);
        if (!t) {
          send(ws, { type: 'error', message: 'Tournament not found' });
          return;
        }
        if (t.players.length >= t.size) {
          send(ws, { type: 'error', message: 'Tournament is full' });
          return;
        }
        ws.tournament = code;
        t.players.push(ws);
        const names = t.players.map((p) => p.name || 'Player');
        t.players.forEach((p) => send(p, { type: 't-joined', room: code, size: t.size, count: t.players.length, names }));
        if (t.players.length === t.size) {
          startTournamentRound(t);
        }
        break;
      }

      case 't-match-result': {
        if (!ws.tournament || !ws.roomCode) return;
        const t = tournaments.get(ws.tournament);
        if (!t) return;
        const match = t.matches.find((m) => m.code === ws.roomCode);
        if (!match || match.winner) return;
        const opp = otherPlayer({ players: match.players }, ws);
        match.winner = msg.iWon ? ws : opp;
        rooms.delete(ws.roomCode);
        ws.roomCode = null;
        if (opp) opp.roomCode = null;
        broadcastBracket(t);
        checkRoundComplete(t);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.tournament) {
      const t = tournaments.get(ws.tournament);
      if (t) {
        const match = t.matches.find((m) => m.players.includes(ws) && !m.winner && !m.bye);
        if (match) {
          const opp = otherPlayer({ players: match.players }, ws);
          match.winner = opp || null;
          if (match.code) rooms.delete(match.code);
          if (opp) opp.roomCode = null;
          broadcastBracket(t);
          checkRoundComplete(t);
        }
        t.players = t.players.filter((p) => p !== ws);
        if (t.players.length === 0) tournaments.delete(ws.tournament);
      }
    }
    cleanupPlayer(ws);
  });
});

function cleanupPlayer(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  const opp = otherPlayer(room, ws);
  if (opp) {
    send(opp, { type: 'opponent-left' });
  }

  room.players = room.players.filter((p) => p !== ws);
  if (room.players.length === 0) {
    rooms.delete(code);
  }
  ws.roomCode = null;
}

/* ============================================================
 * Admin dashboard API
 * ============================================================ */

function adminSnapshot() {
  const roomList = [];
  rooms.forEach((room, code) => {
    if (room.tournament) return; // shown inside the tournament's matches instead
    roomList.push({
      code,
      players: room.players.map((p) => ({ id: p.id, name: p.name || 'Player', symbol: p.symbol })),
    });
  });

  const tournamentList = [];
  tournaments.forEach((t, code) => {
    tournamentList.push({
      code,
      size: t.size,
      round: t.round,
      players: t.players.map((p) => ({ id: p.id, name: p.name || 'Player', eliminated: !!p.tEliminated })),
      matches: t.matches.map((m) => ({
        p1: m.players[0] ? (m.players[0].name || 'Player') : null,
        p2: !m.bye && m.players[1] ? (m.players[1].name || 'Player') : null,
        bye: m.bye,
        winner: m.winner ? (m.winner.name || 'Player') : null,
      })),
    });
  });

  return {
    uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    connectedCount: clients.size,
    connections: Array.from(clients).map((c) => ({
      id: c.id,
      name: c.name || 'Player',
      roomCode: c.roomCode,
      tournament: c.tournament,
      connectedForSec: Math.floor((Date.now() - c.connectedAt) / 1000),
    })),
    rooms: roomList,
    tournaments: tournamentList,
  };
}

function adminBroadcast(text) {
  const message = String(text || '').slice(0, 500);
  if (!message.trim()) return;
  clients.forEach((c) => send(c, { type: 'system-announcement', text: message }));
}

function adminCloseRoom(code, actorLabel) {
  const room = rooms.get(code);
  if (!room) return false;
  room.players.forEach((p) => {
    send(p, { type: 'system-announcement', text: `This room was closed by ${actorLabel}.` });
    send(p, { type: 'opponent-left' });
    p.roomCode = null;
  });
  rooms.delete(code);
  return true;
}

function adminCloseTournament(code, actorLabel) {
  const t = tournaments.get(code);
  if (!t) return false;
  t.players.forEach((p) => {
    send(p, { type: 'system-announcement', text: `This tournament was cancelled by ${actorLabel}.` });
    p.roomCode = null;
    p.tournament = null;
  });
  t.matches.forEach((m) => {
    if (m.code) rooms.delete(m.code);
  });
  tournaments.delete(code);
  return true;
}

function adminKick(id, actorLabel) {
  const target = Array.from(clients).find((c) => c.id === id);
  if (!target) return false;
  send(target, { type: 'system-announcement', text: `You have been disconnected by ${actorLabel}.` });
  try {
    target.close(1000, 'Kicked by staff');
  } catch (e) {
    /* ignore */
  }
  return true;
}

function adminWarn(id, message, actorLabel) {
  const target = Array.from(clients).find((c) => c.id === id);
  if (!target) return false;
  const text = String(message || '').slice(0, 300).trim();
  if (!text) return false;
  send(target, { type: 'system-announcement', text: `Warning from ${actorLabel}: ${text}` });
  return true;
}

async function handleAdminApi(req, res, reqPath) {
  const role = keyRole(req);
  if (!role) {
    sendJson(res, 401, { ok: false, error: 'Invalid or missing key' });
    return;
  }
  const actorLabel = role === 'admin' ? 'an admin' : 'a moderator';

  if (reqPath === '/admin/api/state' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, role, ...adminSnapshot() });
    return;
  }

  // Admin-only actions
  if (reqPath === '/admin/api/broadcast' && req.method === 'POST') {
    if (role !== 'admin') { sendJson(res, 403, { ok: false, error: 'Admin key required to broadcast' }); return; }
    const body = await readJsonBody(req);
    adminBroadcast(body.message);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (reqPath === '/admin/api/close-tournament' && req.method === 'POST') {
    if (role !== 'admin') { sendJson(res, 403, { ok: false, error: 'Admin key required to cancel a tournament' }); return; }
    const body = await readJsonBody(req);
    const ok = adminCloseTournament(String(body.code || '').toUpperCase(), actorLabel);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  // Admin + moderator actions
  if (reqPath === '/admin/api/close-room' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ok = adminCloseRoom(String(body.code || '').toUpperCase(), actorLabel);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  if (reqPath === '/admin/api/kick' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ok = adminKick(String(body.id || ''), actorLabel);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  if (reqPath === '/admin/api/warn' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ok = adminWarn(String(body.id || ''), body.message, actorLabel);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Unknown admin endpoint' });
}

httpServer.listen(PORT, () => {
  console.log(`Tic Tac Toe server running at http://localhost:${PORT}`);
  console.log(`WebSocket relay available at ws://localhost:${PORT}`);
  console.log(`Admin dashboard available at http://localhost:${PORT}/admin.html`);
  console.log(`Moderator panel available at http://localhost:${PORT}/mod.html`);
});
