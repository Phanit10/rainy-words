'use strict';

// Shared by the test files: starts the real server, and drives it with real socket clients.

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { SERVER_PORT } = require('../public/config.js');

const URL = `http://localhost:${SERVER_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { passed: 0, failed: 0 };

function check(name, ok, detail = '') {
  tally[ok ? 'passed' : 'failed'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

function once(socket, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function assertPortFree() {
  return new Promise((resolve, reject) => {
    const probe = net.connect(SERVER_PORT, '127.0.0.1');
    probe.on('connect', () => {
      probe.destroy();
      reject(new Error(`port ${SERVER_PORT} is in use. Stop the running server first.`));
    });
    probe.on('error', () => resolve());
  });
}

/**
 * Starts server.js. By default: no LLM key (even if .env has one, so tests never spend money), and no voice
 * or theme model (so the logic tests don't wait for models and stay predictable). Pass env to override.
 */
async function startServer(env = {}) {
  await assertPortFree();
  const output = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', VOICE: 'off', VOICE_NAME: '', THEME_AI: 'off', ...env },
  });
  proc.stdout.on('data', (b) => output.push(b.toString()));
  proc.stderr.on('data', (b) => output.push(b.toString()));
  await sleep(1200);
  return {
    proc,
    log: () => output.join(''),
    stop: async () => {
      proc.kill();
      await sleep(400);
    },
  };
}

function player() {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const p = {
    socket, lobby: null, words: new Map(), claimed: [], gone: [], stats: null, events: [],
    weather: [], difficulty: [], commentary: [], states: 0, stateGaps: [], lastStateAt: 0, maxAbsVx: 0,
  };
  socket.on('lobby', (d) => (p.lobby = d));
  socket.on('matchPreparing', () => p.words.clear()); // like the real client: a new match starts with an empty field
  socket.on('wordSpawn', (d) => p.words.set(d.id, d));
  socket.on('wordClaimed', (d) => {
    p.words.delete(d.id);
    p.claimed.push(d);
    p.stats = d.stats;
  });
  socket.on('wordGone', (d) => {
    p.words.delete(d.id);
    p.gone.push(d);
  });
  socket.on('stats', (d) => (p.stats = d.stats));
  socket.on('weather', (d) => p.weather.push(d));
  socket.on('difficulty', (d) => p.difficulty.push(d));
  socket.on('commentary', (d) => p.commentary.push({ ...d, at: Date.now() }));
  socket.on('state', (d) => {
    const now = Date.now();
    if (p.lastStateAt) p.stateGaps.push(now - p.lastStateAt);
    p.lastStateAt = now;
    p.states += 1;
    for (const [, , , vx] of d.w) p.maxAbsVx = Math.max(p.maxAbsVx, Math.abs(vx));
  });
  for (const ev of ['matchPreparing', 'matchStart', 'matchGo', 'matchEnd', 'rematchStatus', 'opponentLeft', 'matchCancelled', 'serverReset']) {
    socket.on(ev, (d) => p.events.push([ev, d]));
  }
  return p;
}

/** Types whichever word is falling until it scores. */
async function claimOne(p) {
  for (;;) {
    const word = [...p.words.values()][0];
    if (word && (await emitAck(p.socket, 'submit', word.text)).result === 'hit') return word;
    await sleep(40);
  }
}

function finish() {
  console.log(`\n${tally.passed} passed, ${tally.failed} failed\n`);
  process.exit(tally.failed ? 1 : 0);
}

module.exports = { URL, sleep, tally, check, once, emitAck, startServer, player, claimOne, finish, io };
