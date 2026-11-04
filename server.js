'use strict';

/**
 * Rainy Words — game server.
 *
 * One process does three jobs: serves the client files, runs the authoritative game
 * over Socket.IO, and hosts the server console (/admin) with the live client list,
 * the current word set and the Reset button.
 */

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

// Optional .env next to this file — where the LLM key goes (see .env.example).
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env: the AI features use their offline fallbacks */
}

const { SERVER_HOST, SERVER_PORT } = require('./public/config.js');
const llm = require('./llm');
const voice = require('./voice');
const themeWords = require('./theme-words');
const bank = require('./wordbank');

/* ── Tunables ────────────────────────────────────────────────────────────── */

const MATCH_MS = 60_000; // a match is exactly one minute
const COUNTDOWN_MS = 3_000;
const TICK_MS = 50; // physics + state broadcast, 20 Hz
const MAX_FALLING = 9;
const GRACE_MS = 1_500; // typing a word this soon after it vanished is "too late", not a typo
const NAME_MAX = 12;
const THEME_MAX = 24;

const TIERS = ['easy', 'medium', 'hard'];
const WORDS_PER_TIER = { easy: 24, medium: 26, hard: 28 };
const ASK_PER_TIER = { easy: 28, medium: 30, hard: 32 }; // ask the model for a few spares
const tierOf = (word) => (word.length <= 4 ? 'easy' : word.length <= 6 ? 'medium' : 'hard');

// Difficulty levels: seconds for a word to cross the field, seconds between spawns, tier mix in %.
const LEVELS = [
  null,
  { fall: 11.0, gap: 2.0, mix: [80, 20, 0] },
  { fall: 9.5, gap: 1.7, mix: [55, 40, 5] },
  { fall: 8.2, gap: 1.45, mix: [30, 50, 20] },
  { fall: 7.0, gap: 1.25, mix: [15, 45, 40] },
  { fall: 6.0, gap: 1.05, mix: [5, 35, 60] },
];
const START_LEVEL = 2;
const EVAL_MS = 5_000; // how often the director re-reads the players' accuracy
const ACCURACY_WINDOW = 8; // submissions per player it looks at

// Storm mode: consecutive correct words → score multiplier. [streak needed, multiplier], ascending.
const COMBO_STEPS = [[3, 2], [6, 3], [10, 4]];
const MILESTONES = { storm: [3, 6, 10], classic: [5, 10] }; // streaks the commentator calls out

// Storm mode weather. wind is −1…1 (sign = direction), rain is 0…1.
const WIND_FORCE = 0.16; // sideways acceleration at full wind on a word of mass 1, in field widths / s²
const AIR_DRAG = 1.4;
const TURBULENCE = 0.035;
const FRONTS = [
  { key: 'drizzle', label: 'Drizzle', wind: 0.15, rain: 0.25 },
  { key: 'breeze', label: 'Breeze', wind: 0.45, rain: 0.4 },
  { key: 'crosswind', label: 'Crosswind', wind: 0.75, rain: 0.55 },
  { key: 'downpour', label: 'Downpour', wind: 0.2, rain: 1.0 },
  { key: 'gale', label: 'Gale', wind: 1.0, rain: 0.8 },
  { key: 'calm', label: 'Eye of the storm', wind: 0, rain: 0.1 },
];

const THEMES = [
  'ocean', 'outer space', 'jungle', 'kitchen', 'music', 'sports', 'weather', 'city life',
  'school', 'travel', 'animals', 'technology', 'garden', 'mountains', 'movies', 'breakfast',
];

// Commentary budget: batch events, then at most one request per cooldown and a cap per match.
const BOOTH_COOLDOWN_AI = 6_000;
const BOOTH_COOLDOWN_LOCAL = 2_500;
const BOOTH_MAX_AI_CALLS = 8;

/* ── State ───────────────────────────────────────────────────────────────── */

const clients = new Map(); // socket.id → { id, name, status, ready, readyAt, wins, ip, since }
let lobbyMode = 'classic'; // 'classic' (the assignment's rules, so the default) or 'storm' (all extras)
let lobbyTheme = null; // a theme typed in the lobby, or null for a random one each match
let match = null; // the single arena: null, or a match in phase preparing → countdown → playing → ended
let matchSeq = 0;
let readySeq = 0;
const startedAt = Date.now();
const history = [];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // clients may be opened straight from disk on another computer
const consoleRoom = io.of('/admin');

/* ── Small helpers ───────────────────────────────────────────────────────── */

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const reply = (ack, data) => typeof ack === 'function' && ack(data);

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function log(line) {
  const stamp = new Date().toLocaleTimeString('en-GB');
  console.log(`[${stamp}] ${line}`);
  history.push(`${stamp}  ${line}`);
  if (history.length > 60) history.shift();
  pushConsole();
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}

// The console and its Reset button only answer to the server computer itself.
function isServerComputer(address) {
  const own = new Set(['127.0.0.1', '::1']);
  for (const net of Object.values(os.networkInterfaces()).flat()) if (net) own.add(net.address);
  return own.has(String(address || '').replace(/^::ffff:/, ''));
}

function cleanName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

function cleanTheme(raw) {
  return String(raw ?? '')
    .replace(/[^a-zA-Z0-9 '-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, THEME_MAX)
    .toLowerCase();
}

const named = () => [...clients.values()].filter((c) => c.name);
const isPlayer = (m, id) => Boolean(m && m.stats[id]);

function multiplierFor(streak, mode) {
  if (mode !== 'storm') return 1; // classic: every word is worth exactly one point
  let mult = 1;
  for (const [need, value] of COMBO_STEPS) if (streak >= need) mult = value;
  return mult;
}

/* ── What clients and the console get to see ─────────────────────────────── */

function lobbySnapshot() {
  return {
    online: clients.size,
    players: named().map((c) => ({ id: c.id, name: c.name, status: c.status, ready: c.ready, wins: c.wins })),
    mode: lobbyMode,
    theme: lobbyTheme,
    match: match && match.phase !== 'ended' ? { players: match.order.map((id) => match.stats[id].name) } : null,
  };
}

function broadcastLobby() {
  io.emit('lobby', lobbySnapshot());
  pushConsole();
}

function publicStats(m) {
  const out = {};
  for (const id of m.order) {
    const s = m.stats[id];
    const tries = s.hits + s.misses;
    out[id] = {
      score: s.score,
      streak: s.streak,
      mult: multiplierFor(s.streak, m.mode),
      best: s.best,
      hits: s.hits,
      misses: s.misses,
      accuracy: tries ? Math.round((s.hits / tries) * 100) : null,
    };
  }
  return out;
}

function consoleSnapshot() {
  const m = match;
  return {
    server: { host: SERVER_HOST, port: SERVER_PORT, lan: lanAddresses(), startedAt },
    online: clients.size,
    clients: [...clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      ready: c.ready,
      wins: c.wins,
      ip: c.ip,
      since: c.since,
      score: isPlayer(m, c.id) ? m.stats[c.id].score : null,
    })),
    mode: lobbyMode,
    theme: lobbyTheme,
    match: m && {
      id: m.id,
      phase: m.phase,
      mode: m.mode,
      theme: m.theme,
      source: m.source,
      level: m.level,
      weather: m.weather.label,
      timeLeftMs: m.phase === 'playing' ? Math.max(0, m.endAt - Date.now()) : m.phase === 'ended' ? 0 : MATCH_MS,
      players: m.order.map((id) => ({ id, name: m.stats[id].name, ...publicStats(m)[id] })),
      words: m.words,
    },
    ai: llm.status(),
    themeAi: themeWords.status(),
    voice: voice.status(),
    log: history.slice(-30),
  };
}

let consoleTimer = null;
function pushConsole() {
  if (consoleTimer) return; // coalesce bursts of changes into one update
  consoleTimer = setTimeout(() => {
    consoleTimer = null;
    consoleRoom.emit('state', consoleSnapshot());
  }, 60);
}

function logClients() {
  const names = [...clients.values()].map((c) => c.name || '(choosing a nickname)');
  log(`[clients] ${clients.size} connected${names.length ? `: ${names.join(', ')}` : ''}`);
}

/* ── Word sets ───────────────────────────────────────────────────────────── */

/**
 * A fresh, unique word set for the theme. With a key, one bulk LLM request writes it; without one, the
 * local embedding model picks the best fits from our word pool. Either way it's topped up from the bank.
 */
async function buildWordSet(theme) {
  let fromModel = null;
  if (llm.enabled()) {
    try {
      fromModel = await llm.generateWords({ theme, counts: ASK_PER_TIER });
    } catch (err) {
      log(`[ai] word generation failed (${err.message}); using the local word bank`);
    }
  }
  const ranked = fromModel ? null : await themeWords.rank(theme); // every pool word, best fit first

  const set = { easy: [], medium: [], hard: [] };
  const seen = new Set();
  const add = (raw) => {
    const word = String(raw).toLowerCase().trim();
    if (!/^[a-z]{3,10}$/.test(word) || seen.has(word)) return;
    const tier = tierOf(word); // trust the length, not the label the word arrived with
    if (set[tier].length >= WORDS_PER_TIER[tier]) return;
    seen.add(word);
    set[tier].push(word);
  };

  if (fromModel) for (const tier of TIERS) shuffle(fromModel[tier]).forEach(add);
  else if (ranked) {
    for (const tier of TIERS) {
      // best fits first, each nudged a few places at random so a rematch on the same theme gets a fresh mix
      ranked
        .filter((word) => tierOf(word) === tier)
        .map((word, i) => ({ word, key: i + Math.random() * 6 }))
        .sort((a, b) => a.key - b.key)
        .forEach(({ word }) => add(word));
    }
  }
  const modelWords = seen.size;
  for (const tier of TIERS) shuffle([...bank[tier]]).forEach(add); // fills whatever is still missing

  const kind = fromModel ? 'ai' : ranked ? 'local-ai' : 'bank';
  const source = modelWords === 0 ? 'bank' : modelWords === seen.size ? kind : `${kind}+bank`;
  return { set, source, ordered: Boolean(ranked), theme: source === 'bank' ? 'mixed bag' : theme };
}

function drawWord(m) {
  const mix = LEVELS[m.level].mix;
  let roll = Math.random() * 100;
  let want = 2;
  for (let i = 0; i < 3; i++) {
    if (roll < mix[i]) {
      want = i;
      break;
    }
    roll -= mix[i];
  }
  // nearest tier that still has unused words
  const order = [0, 1, 2].sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  for (const i of order) {
    const text = m.pool[TIERS[i]].pop();
    if (text) return text;
  }
  return null;
}

function spawnWord(m) {
  const text = drawWord(m);
  if (!text) return;
  const half = 0.03 + text.length * 0.011; // rough half-width of the word, in field widths

  // keep new words away from the ones still near the top
  let x = 0.5;
  let bestGap = -1;
  for (let i = 0; i < 6; i++) {
    const candidate = half + 0.02 + Math.random() * (1 - 2 * half - 0.04);
    let gap = 1;
    for (const other of m.active.values()) if (other.y < 0.3) gap = Math.min(gap, Math.abs(candidate - other.x));
    if (gap > bestGap) {
      bestGap = gap;
      x = candidate;
    }
  }

  const word = {
    id: ++m.wordSeq,
    text,
    tier: tierOf(text),
    x,
    y: 0,
    vx: 0,
    vy: 0,
    half,
    mass: 0.75 + text.length * 0.09, // long words are heavier, so the wind moves them less
    drift: 0.9 + Math.random() * 0.2, // each word falls at a slightly different pace
    phase: Math.random() * Math.PI * 2,
  };
  m.active.set(word.id, word);
  m.byText.set(text, word);
  m.wordIndex.get(text).state = 'falling';
  io.to(m.room).emit('wordSpawn', { id: word.id, text, tier: word.tier, x: r4(x), y: 0 });
}

/* ── Simulation ──────────────────────────────────────────────────────────── */

function stepWeather(m, now, dt) {
  const wx = m.weather;
  if (now >= wx.nextFrontAt) {
    const front = pick(FRONTS.filter((f) => f.key !== wx.key));
    wx.key = front.key;
    wx.label = front.label;
    wx.targetWind = front.wind * (Math.random() < 0.5 ? -1 : 1);
    wx.targetRain = front.rain;
    wx.nextFrontAt = now + 6_500 + Math.random() * 3_500;
    io.to(m.room).emit('weather', { key: wx.key, label: wx.label, wind: wx.targetWind, rain: wx.targetRain });
  }
  const ease = 1 - Math.exp(-dt / 0.9);
  wx.wind += (wx.targetWind - wx.wind) * ease;
  wx.rain += (wx.targetRain - wx.rain) * ease;
}

/** Moves one word by dt seconds; returns its sideways speed for the clients to extrapolate with. */
function stepWord(m, word, dt, t) {
  const fallSpeed = 1 / LEVELS[m.level].fall;
  let sideways = 0;
  if (m.mode === 'storm') {
    const wx = m.weather;
    word.vx += ((wx.wind * WIND_FORCE) / word.mass - word.vx * AIR_DRAG) * dt; // wind pushes, air drag resists
    sideways = word.vx + Math.sin(t * 1.7 + word.phase) * TURBULENCE * wx.rain; // heavier rain → more buffeting
    word.vy = fallSpeed * word.drift * (0.9 + 0.35 * wx.rain); // heavier rain → faster fall
  } else {
    word.vy = fallSpeed;
  }
  word.x += sideways * dt;
  word.y += word.vy * dt;

  const lo = word.half + 0.01;
  const hi = 1 - lo;
  if (word.x < lo) {
    word.x = lo;
    word.vx = Math.abs(word.vx) * 0.4;
  } else if (word.x > hi) {
    word.x = hi;
    word.vx = -Math.abs(word.vx) * 0.4;
  }
  return sideways;
}

function dropWord(m, word, now) {
  m.active.delete(word.id);
  m.byText.delete(word.text);
  m.recent.set(word.text, { by: null, at: now });
  m.wordIndex.get(word.text).state = 'missed';
  m.dropsSinceEval += 1;
  io.to(m.room).emit('wordGone', { id: word.id });
}

/**
 * Difficulty director (storm mode): every few seconds, read both players' recent accuracy
 * and how many words reached the ground, then move the level — which sets word length,
 * fall speed and spawn rate. Words are shared, so the level is shared too.
 */
function directDifficulty(m, now) {
  if (now < m.nextEvalAt) return;
  m.nextEvalAt = now + EVAL_MS;
  const drops = m.dropsSinceEval;
  const fresh = m.submitsSinceEval;
  m.dropsSinceEval = 0;
  m.submitsSinceEval = 0;

  const recent = m.order.flatMap((id) => m.stats[id].window);
  const accuracy = recent.length ? recent.reduce((sum, hit) => sum + hit, 0) / recent.length : null;
  const percent = accuracy === null ? null : Math.round(accuracy * 100);

  let next = m.level;
  let why = '';
  if (drops >= 3) {
    next -= 1;
    why = `${drops} words reached the ground`;
  } else if (fresh >= 2 && recent.length >= 3 && accuracy < 0.6) {
    next -= 1;
    why = `accuracy ${percent}%`;
  } else if (fresh >= 2 && recent.length >= 4 && accuracy >= 0.85 && drops <= 1) {
    next += 1;
    why = `accuracy ${percent}%`;
  }
  next = clamp(next, 1, LEVELS.length - 1);
  if (next === m.level) return;

  const dir = next > m.level ? 'up' : 'down';
  m.level = next;
  io.to(m.room).emit('difficulty', { level: next, dir, why });
  log(`[match ${m.id}] difficulty ${dir} to ${next}/5 (${why})`);
}

function tick(m) {
  if (match !== m || m.phase !== 'playing') return;
  const now = Date.now();
  const dt = Math.min(0.1, (now - m.lastTick) / 1000);
  m.lastTick = now;
  const left = m.endAt - now;
  if (left <= 0) return endMatch(m, 'time');

  if (m.mode === 'storm') {
    stepWeather(m, now, dt);
    directDifficulty(m, now);
  }

  if (!m.finalStretch && left <= 10_000) {
    m.finalStretch = true;
    comment(m, { type: 'final_stretch', say: '10 seconds left' });
  }

  if (now >= m.nextSpawnAt && left > 1_500 && m.active.size < MAX_FALLING) {
    spawnWord(m);
    m.nextSpawnAt = now + LEVELS[m.level].gap * 1000 * (0.85 + Math.random() * 0.3);
  }

  const t = (now - m.startAt) / 1000;
  const falling = [];
  for (const word of m.active.values()) {
    const sideways = stepWord(m, word, dt, t);
    if (word.y >= 1) dropWord(m, word, now);
    else falling.push([word.id, r4(word.x), r4(word.y), r4(sideways), r4(word.vy)]);
  }
  io.to(m.room).volatile.emit('state', { t: left, w: falling, wind: r4(m.weather.wind), rain: r4(m.weather.rain) });
  if (++m.ticks % 10 === 0) pushConsole();
}

/* ── Commentary ──────────────────────────────────────────────────────────── */

function scoreline(m) {
  const [a, b] = m.order.map((id) => m.stats[id]);
  const clock = m.phase === 'ended' ? 'Final whistle.' : `${Math.max(0, Math.ceil((m.endAt - Date.now()) / 1000))}s left.`;
  return `${a.name} ${a.score} (streak ${a.streak}) vs ${b.name} ${b.score} (streak ${b.streak}). ${clock} Weather: ${m.weather.label}. Difficulty ${m.level}/5.`;
}

/** Queue a major event for the commentator. Events are batched; force skips the cooldown. */
function comment(m, event, force = false) {
  const booth = m.booth;
  booth.pending.push(event);
  if (booth.pending.length > 3) booth.pending.shift(); // only the three freshest events ride in one request
  if (booth.busy) return; // speak() reschedules when the request in flight returns
  if (booth.timer) {
    if (!force) return;
    clearTimeout(booth.timer);
  }
  const cooldown = llm.enabled() ? BOOTH_COOLDOWN_AI : BOOTH_COOLDOWN_LOCAL;
  const wait = force ? 0 : Math.max(0, booth.lastAt + cooldown - Date.now(), booth.talkingUntil - Date.now());
  booth.timer = setTimeout(() => speak(m).catch(console.error), wait);
}

async function speak(m) {
  const booth = m.booth;
  booth.timer = null;
  if (match !== m || !booth.pending.length) return;
  const events = booth.pending.splice(0);
  const final = events.some((e) => e.type === 'match_end');
  booth.busy = true;
  booth.lastAt = Date.now();

  let text = null;
  let source = 'local';
  if (llm.enabled() && (booth.aiCalls < BOOTH_MAX_AI_CALLS || final)) {
    booth.aiCalls += 1;
    try {
      text = await llm.commentate({ scoreline: scoreline(m), events: events.map((e) => e.say) });
      source = 'ai';
    } catch (err) {
      log(`[ai] commentary failed (${err.message}); using a local line`);
    }
  }
  if (!text) text = llm.localLine(events[events.length - 1]);
  const spoken = await voice.say(text); // null when this line stays text-only

  booth.busy = false;
  if (match !== m) return; // reset or rematch while the model was thinking
  if (spoken) booth.talkingUntil = Date.now() + spoken.durationMs;
  io.to(m.room).emit('commentary', { text, source, final, audio: spoken ? spoken.wav : null });
  pushConsole();
  if (booth.pending.length) {
    const urgent = booth.pending.some((e) => e.type === 'match_end');
    const event = booth.pending.pop();
    comment(m, event, urgent);
  }
}

/* ── Match lifecycle ─────────────────────────────────────────────────────── */

function newMatch(ids, mode) {
  const stats = {};
  for (const id of ids) {
    stats[id] = { name: clients.get(id).name, score: 0, streak: 0, best: 0, hits: 0, misses: 0, late: 0, window: [], lastSubmitAt: 0 };
  }
  const id = ++matchSeq;
  const storm = mode === 'storm';
  return {
    id,
    room: `match-${id}`,
    mode,
    phase: 'preparing',
    order: ids,
    stats,
    theme: lobbyTheme || pick(THEMES),
    source: 'bank',
    words: [], // the full set for the console: { text, tier, state, by }
    wordIndex: new Map(),
    pool: { easy: [], medium: [], hard: [] },
    active: new Map(), // id → falling word
    byText: new Map(), // text → falling word
    recent: new Map(), // text → { by, at } for words that just left the field
    wordSeq: 0,
    level: START_LEVEL,
    nextEvalAt: 0,
    dropsSinceEval: 0,
    submitsSinceEval: 0,
    weather: storm
      ? { key: 'drizzle', label: 'Drizzle', wind: 0, rain: 0.3, targetWind: 0, targetRain: 0.3, nextFrontAt: 0 }
      : { key: 'steady', label: 'Steady rain', wind: 0, rain: 0.45, targetWind: 0, targetRain: 0.45, nextFrontAt: Infinity },
    startAt: 0,
    endAt: 0,
    lastTick: 0,
    nextSpawnAt: 0,
    ticks: 0,
    finalStretch: false,
    leader: null,
    rematch: new Set(),
    rematchOpen: false,
    booth: { pending: [], timer: null, busy: false, lastAt: 0, talkingUntil: 0, aiCalls: 0 },
    timers: { start: null, tick: null, end: null },
  };
}

function stopTimers(m) {
  clearTimeout(m.timers.start);
  clearInterval(m.timers.tick);
  clearTimeout(m.timers.end);
  clearTimeout(m.booth.timer);
  m.booth.timer = null;
}

function tryStartMatch() {
  if (match && match.phase !== 'ended') return;
  const ready = [...clients.values()].filter((c) => c.status === 'lobby' && c.ready).sort((a, b) => a.readyAt - b.readyAt);
  if (ready.length < 2) return;
  if (match) closeResults('A new match is starting.');
  launch([ready[0].id, ready[1].id], lobbyMode);
}

function launch(ids, mode) {
  startMatch(ids, mode).catch((err) => {
    console.error(err);
    if (match && match.phase === 'preparing') cancelMatch(match, 'The server could not start the match.');
  });
}

async function startMatch(ids, mode) {
  const m = newMatch(ids, mode);
  match = m;
  for (const id of ids) {
    const c = clients.get(id);
    c.status = 'playing';
    c.ready = false;
    c.readyAt = 0;
    io.sockets.sockets.get(id)?.join(m.room);
  }
  const players = ids.map((id) => ({ id, name: m.stats[id].name }));
  io.to(m.room).emit('matchPreparing', {
    matchId: m.id,
    mode,
    theme: m.theme,
    players,
    ai: llm.enabled(),
    themeAi: themeWords.available(),
    voice: voice.available(),
  });
  log(`[match ${m.id}] ${players.map((p) => p.name).join(' vs ')}, ${mode} mode: generating words…`);
  broadcastLobby();

  const built = await buildWordSet(m.theme); // the only word request this match will make
  if (match !== m || m.phase !== 'preparing') return; // reset, or a player left while we waited

  m.theme = built.theme;
  m.source = built.source;
  for (const tier of TIERS) {
    for (const text of built.set[tier]) {
      const record = { text, tier, state: 'queued', by: null };
      m.words.push(record);
      m.wordIndex.set(text, record);
    }
    m.pool[tier] = built.ordered ? [...built.set[tier]].reverse() : shuffle([...built.set[tier]]); // spawning pops from the end, so best fits fall first
  }
  log(`[match ${m.id}] word set (${m.words.length} unique, source: ${m.source}, theme: ${m.theme}): ${m.words.map((w) => w.text).join(' ')}`);

  m.phase = 'countdown';
  io.to(m.room).emit('matchStart', {
    matchId: m.id,
    mode,
    theme: m.theme,
    source: m.source,
    players,
    countdownMs: COUNTDOWN_MS,
    durationMs: MATCH_MS,
    level: m.level,
    combo: mode === 'storm' ? COMBO_STEPS : [],
    weather: { key: m.weather.key, label: m.weather.label, wind: 0, rain: m.weather.rain },
    stats: publicStats(m),
  });
  pushConsole();
  m.timers.start = setTimeout(() => beginPlay(m), COUNTDOWN_MS);
}

function beginPlay(m) {
  if (match !== m || m.phase !== 'countdown') return;
  const now = Date.now();
  m.phase = 'playing';
  m.startAt = now;
  m.endAt = now + MATCH_MS;
  m.lastTick = now;
  m.nextEvalAt = now + EVAL_MS;
  m.nextSpawnAt = now + LEVELS[m.level].gap * 600;
  m.weather.nextFrontAt = m.mode === 'storm' ? now + 4_500 : Infinity;
  io.to(m.room).emit('matchGo', { durationMs: MATCH_MS });
  spawnWord(m);
  spawnWord(m);
  m.timers.tick = setInterval(() => tick(m), TICK_MS);
  m.timers.end = setTimeout(() => endMatch(m, 'time'), MATCH_MS);
  log(`[match ${m.id}] started, 60 seconds on the clock`);
}

function endMatch(m, reason, leaverId = null) {
  if (match !== m || m.phase === 'ended') return;
  stopTimers(m);
  m.phase = 'ended';
  for (const word of m.active.values()) m.wordIndex.get(word.text).state = 'unplayed';
  m.active.clear();
  m.byText.clear();

  const [a, b] = m.order;
  const sa = m.stats[a];
  const sb = m.stats[b];
  let winnerId = null;
  if (reason === 'forfeit') winnerId = m.order.find((id) => id !== leaverId);
  else if (sa.score !== sb.score) winnerId = sa.score > sb.score ? a : b;
  if (winnerId && clients.has(winnerId)) clients.get(winnerId).wins += 1;
  m.rematchOpen = reason !== 'forfeit';

  const stats = publicStats(m);
  const players = m.order.map((id) => ({ id, name: m.stats[id].name, ...stats[id] }));
  for (const id of m.order) {
    const c = clients.get(id);
    if (!c) continue;
    c.status = 'results';
    io.to(id).emit('matchEnd', {
      reason,
      result: winnerId === null ? 'Draw' : winnerId === id ? 'Win' : 'Lost',
      winnerId,
      players,
      canRematch: m.rematchOpen,
      note: reason === 'forfeit' ? `${m.stats[leaverId].name} disconnected.` : '',
    });
  }

  const score = `${Math.max(sa.score, sb.score)}-${Math.min(sa.score, sb.score)}`;
  const winner = winnerId ? m.stats[winnerId].name : null;
  const say =
    reason === 'forfeit'
      ? `${m.stats[leaverId].name} disconnected, so ${winner} wins by forfeit`
      : winner
        ? `Match over: ${winner} wins ${score}`
        : `Match over: a ${score} draw`;
  comment(m, { type: 'match_end', winner, score, say }, true);

  log(`[match ${m.id}] ended (${reason}): ${sa.name} ${sa.score}, ${sb.name} ${sb.score}${winner ? `. Winner: ${winner}` : '. Draw'}`);
  broadcastLobby();
}

/** Before play begins: a player left, so the remaining one goes back to the lobby. */
function cancelMatch(m, message) {
  stopTimers(m);
  match = null;
  for (const id of m.order) {
    const c = clients.get(id);
    if (!c) continue;
    c.status = 'lobby';
    io.to(id).emit('matchCancelled', { message });
  }
  io.in(m.room).socketsLeave(m.room);
  log(`[match ${m.id}] cancelled: ${message}`);
}

/** Clears a finished match off the arena and sends whoever is still on the results screen to the lobby. */
function closeResults(message) {
  const m = match;
  if (!m) return;
  stopTimers(m);
  match = null;
  for (const id of m.order) {
    const c = clients.get(id);
    if (!c || c.status !== 'results') continue;
    c.status = 'lobby';
    io.to(id).emit('matchCancelled', { message });
  }
  io.in(m.room).socketsLeave(m.room);
}

/** A player walks away from the results screen (or disconnects there): no rematch is possible any more. */
function leaveResults(m, id, name) {
  m.rematchOpen = false;
  m.rematch.clear();
  io.sockets.sockets.get(id)?.leave(m.room);
  io.to(m.room).emit('opponentLeft', { name });
  const someoneStays = m.order.some((other) => other !== id && clients.get(other)?.status === 'results');
  if (!someoneStays) {
    stopTimers(m);
    match = null;
  }
}

/** The console's Reset button: stop the current game and zero every score. */
function resetGame() {
  const m = match;
  if (m) {
    stopTimers(m);
    match = null;
    io.in(m.room).socketsLeave(m.room);
  }
  for (const c of clients.values()) {
    c.wins = 0;
    c.ready = false;
    c.readyAt = 0;
    if (c.name) c.status = 'lobby';
  }
  io.emit('serverReset', { message: 'The server reset the game. All scores are back to zero.' });
  log('[reset] game and scores reset from the server console');
  broadcastLobby();
}

/* ── Scoring ─────────────────────────────────────────────────────────────── */

function recordAttempt(m, stat, hit) {
  stat.window.push(hit ? 1 : 0);
  if (stat.window.length > ACCURACY_WINDOW) stat.window.shift();
  m.submitsSinceEval += 1;
}

/**
 * A player submits a word. Node handles one socket event at a time, so when two players
 * send the same word in the same millisecond the first event processed removes the word
 * and the second finds it gone — exactly one of them scores.
 */
function handleSubmit(socket, raw, ack) {
  const m = match;
  if (!isPlayer(m, socket.id) || m.phase !== 'playing') return reply(ack, { result: 'idle' });
  const now = Date.now();
  if (now >= m.endAt) return reply(ack, { result: 'idle' });

  const stat = m.stats[socket.id];
  if (now - stat.lastSubmitAt < 30) return reply(ack, { result: 'idle' }); // nobody types that fast
  stat.lastSubmitAt = now;
  const text = String(raw ?? '').trim().toLowerCase().slice(0, 32);
  if (!text) return reply(ack, { result: 'idle' });

  const word = m.byText.get(text);
  if (word) {
    m.active.delete(word.id);
    m.byText.delete(text);
    m.recent.set(text, { by: socket.id, at: now });
    const record = m.wordIndex.get(text);
    record.state = 'claimed';
    record.by = stat.name;

    stat.hits += 1;
    stat.streak += 1;
    stat.best = Math.max(stat.best, stat.streak);
    recordAttempt(m, stat, true);
    const mult = multiplierFor(stat.streak, m.mode);
    stat.score += mult; // one point per word, times the combo multiplier in storm mode

    io.to(m.room).emit('wordClaimed', { id: word.id, text, by: socket.id, points: mult, stats: publicStats(m) });
    reply(ack, { result: 'hit', points: mult, streak: stat.streak });

    if (MILESTONES[m.mode].includes(stat.streak)) {
      const say = mult > 1 ? `${stat.name} hits a ${stat.streak}-word combo (x${mult} points)` : `${stat.name} is on a ${stat.streak}-word streak`;
      comment(m, { type: 'combo', who: stat.name, n: stat.streak, say });
    }
    const [a, b] = m.order;
    const diff = m.stats[a].score - m.stats[b].score;
    const leader = diff > 0 ? a : diff < 0 ? b : null;
    if (leader && leader !== m.leader) {
      const who = m.stats[leader].name;
      const other = m.stats[leader === a ? b : a].name;
      comment(m, m.leader ? { type: 'lead_change', who, other, say: `${who} overtakes ${other} for the lead` } : { type: 'first_lead', who, say: `${who} scores first` });
      m.leader = leader;
    }
    pushConsole();
    return;
  }

  const gone = m.recent.get(text);
  if (gone && now - gone.at < GRACE_MS) {
    // typed correctly, just not first (or a blink after it landed): no point, no penalty
    stat.late += 1;
    return reply(ack, { result: 'late', by: gone.by && gone.by !== socket.id ? m.stats[gone.by].name : null });
  }

  const lost = stat.streak;
  stat.misses += 1;
  stat.streak = 0;
  recordAttempt(m, stat, false);
  io.to(m.room).emit('stats', { stats: publicStats(m) });
  reply(ack, { result: 'miss', lost });
  if (lost >= 5) comment(m, { type: 'combo_break', who: stat.name, n: lost, say: `${stat.name} mistypes and loses a ${lost}-word streak` });
}

/* ── Player sockets ──────────────────────────────────────────────────────── */

io.on('connection', (socket) => {
  const client = {
    id: socket.id,
    name: null,
    status: 'joining',
    ready: false,
    readyAt: 0,
    wins: 0,
    ip: String(socket.handshake.address || '').replace(/^::ffff:/, ''),
    since: Date.now(),
  };
  clients.set(socket.id, client);
  logClients();
  broadcastLobby(); // the newcomer learns who is online; everyone else sees the new count

  socket.on('join', (payload, ack) => {
    if (client.name) return reply(ack, { ok: false, error: 'You already joined.' });
    const name = cleanName(payload && payload.name);
    if (!name) return reply(ack, { ok: false, error: 'Type a nickname first.' });
    if (named().some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return reply(ack, { ok: false, error: `"${name}" is taken. Pick another nickname.` });
    }
    client.name = name;
    client.status = 'lobby';
    reply(ack, { ok: true, id: socket.id, name, welcome: `Welcome, ${name}.` });
    logClients();
    broadcastLobby();
  });

  socket.on('ready', (flag) => {
    if (client.status !== 'lobby') return;
    client.ready = Boolean(flag);
    client.readyAt = client.ready ? ++readySeq : 0;
    broadcastLobby();
    tryStartMatch();
  });

  socket.on('setMode', (mode) => {
    if (client.status !== 'lobby' || !['storm', 'classic'].includes(mode) || mode === lobbyMode) return;
    lobbyMode = mode;
    log(`[lobby] ${client.name} switched the mode to ${mode}`);
    broadcastLobby();
  });

  socket.on('setTheme', (raw) => {
    if (client.status !== 'lobby') return;
    const theme = cleanTheme(raw) || null;
    if (theme === lobbyTheme) return;
    lobbyTheme = theme;
    log(`[lobby] ${client.name} set the theme to ${theme ? `"${theme}"` : 'random'}`);
    broadcastLobby();
  });

  socket.on('submit', (text, ack) => handleSubmit(socket, text, ack));

  socket.on('rematch', () => {
    const m = match;
    if (!isPlayer(m, socket.id) || m.phase !== 'ended' || !m.rematchOpen || client.status !== 'results') return;
    m.rematch.add(socket.id);
    io.to(m.room).emit('rematchStatus', { agreed: [...m.rematch] });
    if (!m.order.every((id) => m.rematch.has(id))) return;
    log(`[match ${m.id}] both players agreed to a rematch`);
    stopTimers(m);
    io.in(m.room).socketsLeave(m.room);
    launch([...m.order], m.mode); // a new match: new id, new word set
  });

  socket.on('leaveMatch', () => {
    if (client.status !== 'results') return;
    client.status = 'lobby';
    if (isPlayer(match, socket.id)) leaveResults(match, socket.id, client.name);
    broadcastLobby();
    tryStartMatch();
  });

  socket.on('disconnect', () => {
    clients.delete(socket.id);
    const m = match;
    if (isPlayer(m, socket.id)) {
      if (m.phase === 'preparing' || m.phase === 'countdown') cancelMatch(m, `${client.name} disconnected before the match began.`);
      else if (m.phase === 'playing') endMatch(m, 'forfeit', socket.id);
      else leaveResults(m, socket.id, client.name);
    }
    logClients();
    broadcastLobby();
    tryStartMatch();
  });
});

/* ── Server console ──────────────────────────────────────────────────────── */

consoleRoom.use((socket, next) => {
  if (isServerComputer(socket.handshake.address)) return next();
  next(new Error('The server console only opens on the server computer.'));
});

consoleRoom.on('connection', (socket) => {
  socket.emit('state', consoleSnapshot());
  socket.on('reset', (ack) => {
    resetGame();
    reply(ack, { ok: true });
  });
});

const consoleOnly = (req, res, next) =>
  isServerComputer(req.socket.remoteAddress) ? next() : res.status(403).send('The server console only opens on the server computer.');

app.get('/admin', consoleOnly, (req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Go ──────────────────────────────────────────────────────────────────── */

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${SERVER_PORT} is already in use. Stop the other program or change SERVER_PORT in public/config.js.` : err);
  process.exit(1);
});

server.listen(SERVER_PORT, () => {
  const lan = lanAddresses();
  const ai = llm.status();
  console.log(
    [
      '',
      '  Rainy Words server',
      `  listening on      port ${SERVER_PORT}, all network interfaces`,
      `  clients connect   http://${SERVER_HOST}:${SERVER_PORT}   (hardcoded in public/config.js)`,
      `  server console    http://localhost:${SERVER_PORT}/admin`,
      `  this computer     ${lan.length ? lan.join(', ') : 'no LAN address found'}`,
      `  AI                ${ai.enabled ? `${ai.model} ready` : `offline (${ai.reason})`}`,
      `  theme words       ${themeWords.status().state === 'off' ? 'off (THEME_AI=off in .env)' : 'local AI model (all-MiniLM-L6-v2)'}`,
      `  voice             ${voice.status().state === 'off' ? 'off (VOICE=off in .env)' : `Kokoro, ${voice.status().voice}`}`,
      '',
    ].join('\n'),
  );
  if (['localhost', '127.0.0.1'].includes(SERVER_HOST)) {
    console.log(`  Note: SERVER_HOST is "${SERVER_HOST}", so only this computer can play.`);
    console.log(`  For a second computer, run "npm run set-host" and restart.\n`);
  } else if (!lan.includes(SERVER_HOST)) {
    console.log(`  WARNING: SERVER_HOST is ${SERVER_HOST}, but this computer is ${lan.join(', ') || 'on no network'}. Clients will not connect.`);
    console.log('  Close this window and double-click start.command again: it updates the address.\n');
  }
  themeWords.start(log);
  voice.start(log);

  // Joining another Wi-Fi or hotspot gives this computer a new address. Say so, instead of clients failing silently.
  let lastLan = lan.join();
  setInterval(() => {
    const now = lanAddresses();
    if (now.join() === lastLan) return;
    lastLan = now.join();
    if (!['localhost', '127.0.0.1'].includes(SERVER_HOST) && !now.includes(SERVER_HOST)) {
      log(`[network] this computer is now ${now.join(', ') || 'offline'}, but clients look for ${SERVER_HOST}. Close this window and double-click start.command again.`);
    }
  }, 5_000).unref();
});
