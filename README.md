# Ultimate Tic Tac Toe

A modern, mobile-friendly Tic Tac Toe game — served by a small Node.js
server (`server.js`) that hosts both the game (`public/index.html`) and the
WebSocket relay for online multiplayer, tournaments, chat, and reactions,
all on a single port.

## Features

- **Main menu** with a clean glassmorphism UI and inline SVG icons (no emoji
  in the interface chrome)
- **Player vs Player** (local, same device)
- **Player vs Computer** with 4 difficulty levels:
  1. **Easy** — mostly random moves
  2. **Hard** — strong play, rare slip-ups
  3. **Normal** — balanced, moderate randomness
  4. **Impossible** — perfect minimax with alpha-beta pruning, never loses
  - Choose to play as X or O
- **Best-of-3 matches** — every mode (PvP, PvC, Online, Tournament) is played
  as a 3-round match; round wins are tracked with a pip indicator and the
  first player to win 2 rounds (or the round-3 result) takes the match
- **Online Multiplayer** — create a room, share the 4-letter code, play with
  a friend anywhere over WebSocket
- **Tournament Mode** — 4 or 8 player single-elimination online bracket:
  - Create a tournament, share the code, players join until the bracket fills
  - The server randomly seeds pairings each round and relays a live bracket
    view to every player (including eliminated players, who can spectate)
  - Each matchup is a full best-of-3 match; winners advance automatically
  - Odd numbers of remaining players get an automatic bye
  - Ends with a champion screen + confetti
- **In-game chat** (online & tournament matches) — floating chat bubble with
  unread badge, quick-reply chips, and free-text messages
- **Animated emoji reactions** — tap a floating reaction button during any
  match to pop an animated emoji (😍😘😭😂💯😎😈) that floats up over the
  board; in online/tournament games it's relayed live to your opponent too
- **Coins & Gems + Market** — earn coins for round wins/draws and gems for
  match wins, plus a big tournament-champion bonus; spend them in the
  **Market** to unlock and equip cosmetic board color themes and alternate
  X/O mark styles (all persisted locally)
- **Admin Dashboard** (`public/admin.html`) — a password-protected web app
  for server operators: live player count, active quick-match rooms and
  tournament brackets, warn or kick a player, close a room, cancel a
  tournament, and broadcast an announcement banner to everyone connected
- **Moderator Panel** (`public/mod.html`) — a lighter-permission companion
  for community moderators: warn/kick players and close rooms, without
  access to server-wide broadcasts or tournament cancellation
- **Sound effects (SFX)** — fully synthesized with the Web Audio API
  (no audio files needed): clicks, placing marks, win/lose/draw/champion
  jingles, and a coin-pickup chime
- **Visual effects (VFX)** — confetti bursts, winning-line pulse glow,
  screen shake, animated mark pop-ins, floating reaction animations
- **Score & wallet tracking** persisted across sessions (localStorage)
- **Settings panel** — toggle SFX / VFX / haptic vibration
- **Fully responsive & mobile-friendly** — safe-area support, touch-friendly
  hit targets, works great on phones, tablets, and desktop

> **Note on reactions:** the reaction set intentionally excludes offensive
> gestures (e.g. a middle-finger emoji) since reactions are sent directly at
> an opponent, including strangers matched online.

## Project structure

```
.
├── README.md
├── package.json      # Server dependency (ws) + npm start script
├── server.js          # HTTP static server + WebSocket relay (rooms, tournaments, chat, reactions) + Admin/Mod API
└── public/
    ├── index.html      # The game — HTML/CSS/JS, single file
    ├── admin.html      # Admin dashboard — HTML/CSS/JS, single file
    └── mod.html         # Moderator panel — HTML/CSS/JS, single file
```

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:8080** (or the port in `process.env.PORT`).
That's it — the same server serves the game page *and* powers Online
Multiplayer / Tournament Mode, so the app auto-detects its own address.
Player vs Player and Player vs Computer also work if you just open
`public/index.html` directly in a browser (no server needed for those two
modes) — only Online/Tournament need `server.js` running.

### Setting a fixed server address (optional)

If you host the frontend somewhere separate from the WebSocket server, open
`public/index.html` and set the `CONFIG` object near the top of the
`<script>` block:

```js
const CONFIG = {
  SERVER_URL: ""   // e.g. "wss://your-app.onrender.com"
};
```

Every player's Online / Tournament menu will be pre-filled automatically. If
left blank, the game guesses its own origin (great when server.js serves the
page) or falls back to letting players paste a server address manually.

In the game, go to **Online Multiplayer**, then either:
- Tap **Create Room** to get a 4-letter code and share it with a friend, or
- Tap **Join Room** and enter a code someone shared with you.

For a tournament, go to **Tournament Mode**, pick a bracket size (4 or 8),
then **Create Tournament** or **Join Tournament** with a shared code. Once
the bracket fills, matches start automatically.

### Deploying

Deploy the whole `project` folder to any Node host that supports
WebSockets — since HTTP and WS share one port, most platforms need zero
extra config:

- **Render** / **Railway** / **Fly.io** — new Node web service, start
  command `npm start`
- **Glitch** — import the project, it auto-installs and runs
- A VPS — `npm install && npm start`, optionally behind Nginx + TLS
  (proxy both HTTP and WebSocket upgrade requests to the same port)

## Admin Dashboard

Open **`/admin.html`** on your running server (e.g.
`http://localhost:8080/admin.html`) to manage the game live:

- Live counts: connected players, active rooms, active tournaments, uptime
- **Connected Players** — see who's online and where (menu / room / tournament), with **Warn** and **Kick** per player
- **Quick-Match Rooms** — see both players in each room, **Close Room** to end a match and disconnect both players
- **Tournaments** — see the bracket size, current round, player list, and match results, with **Cancel Tournament**
- **Broadcast** — send a message that pops up as a banner on every connected player's screen
- Auto-refreshes every 4 seconds; a status dot shows whether the dashboard can still reach the server

**Setting the admin key:** set the `ADMIN_KEY` environment variable before
starting the server:

```bash
ADMIN_KEY=some-long-random-string npm start
```

If you don't set one, the server falls back to the default key `admin123`
and prints a warning on startup — change this before deploying anywhere
public. The dashboard sends the key in an `x-admin-key` header on every
request; because there's no HTTPS enforcement, rate limiting, or hashing
built in, this is a convenience tool for trusted operators, not a
hardened auth system — always deploy behind HTTPS/WSS and treat the admin
key like a password.

## Moderator Panel

Open **`/mod.html`** for a lighter-weight tool you can hand to community
moderators without giving them full admin power:

- **Warn** a player — sends them a private banner message (good as a first
  notice before a kick)
- **Kick** a player — disconnects them immediately
- **Close Room** — end an active 1v1 match
- Tournaments are shown **read-only** here — cancelling one requires the
  full admin dashboard

**Setting the moderator key:** set the `MOD_KEY` environment variable
(falls back to the default `mod123` with a startup warning if unset):

```bash
MOD_KEY=another-long-random-string npm start
```

The moderator key can only reach the mod-level actions above — the server
rejects broadcast and tournament-cancellation requests from a moderator key
with a 403. An admin key also works in the moderator panel (admins can do
everything a moderator can), but the panel's UI itself never exposes the
admin-only actions, so handing out the mod key alone keeps moderators
scoped to the lighter permission set.

## How to play

1. Open the game and pick a mode from the main menu.
2. **PvP**: players alternate taps on the same device.
3. **vs Computer**: pick a difficulty and your symbol, then play a best-of-3
   match — the AI uses minimax search (unbeatable on Impossible).
4. **Online**: create or join a room with a friend; a best-of-3 match starts
   automatically and moves/chat/reactions sync in real time.
5. **Tournament**: create or join a bracket; when it fills, the server pairs
   players and each round is a best-of-3 match. Winners advance until a
   champion is crowned.
6. Win 3 in a row (horizontal, vertical, or diagonal) to take a round. First
   to 2 round wins (or the better score after 3 rounds) wins the match.
7. Spend coins and gems earned from wins in the **Market** to unlock board
   themes and mark styles.

## Tech notes

- No external libraries in the frontend, no build tools, no bundler —
  `public/index.html` is fully self-contained. All UI icons are inline SVG
  (feather-style); the only literal emoji in the app are the optional
  reaction pop-ups, by design.
- Sound effects are generated on the fly with the Web Audio API
  (oscillators + gain envelopes), so there are no binary audio assets.
- The AI uses **minimax with alpha-beta pruning**; lower difficulties mix in
  random moves so they're beatable.
- `server.js` uses Node's built-in `http` module to serve `public/` and
  attaches the `ws` WebSocket server to the same HTTP server instance —
  one process, one port.
- The multiplayer/tournament relay is intentionally lightweight — it relays
  room/tournament state, moves, chat, and reactions; match logic (win
  detection, round progression, coin/gem rewards) runs on each client and is
  trusted. For competitive/anti-cheat use you'd want to move that validation
  server-side.
- Tournament matches reuse the same 1v1 room machinery as quick-match games,
  so chat, reactions, and best-of-3 round handling work identically inside a
  bracket.
- If a player disconnects mid-tournament-match, their opponent is
  automatically advanced as the winner of that match.
- Coins/gems and unlocked cosmetics are stored in `localStorage` per browser
  — there's no server-side account system.

## License

MIT — do whatever you like with it.
