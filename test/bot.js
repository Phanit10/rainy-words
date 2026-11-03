'use strict';

// A practice opponent, for rehearsing alone:  npm run bot -- [name] [ms between words] [rematch]
//   npm run bot -- Bob 2600 rematch

const { io } = require('socket.io-client');
const { SERVER_PORT } = require('../public/config.js');

const name = process.argv[2] || 'Bot';
const everyMs = Number(process.argv[3] || 2600);
const autoRematch = process.argv[4] === 'rematch';

const socket = io(`http://localhost:${SERVER_PORT}`, { transports: ['websocket'] });
const words = new Map();
let playing = false;
let typed = 0;

const readyUp = () => socket.emit('ready', true);

socket.on('connect', () => {
  socket.emit('join', { name }, (res) => {
    console.log(res.ok ? res.welcome : res.error);
    if (res.ok) readyUp();
  });
});
socket.on('matchPreparing', () => words.clear());
socket.on('wordSpawn', (w) => words.set(w.id, w));
socket.on('wordClaimed', (w) => words.delete(w.id));
socket.on('wordGone', (w) => words.delete(w.id));
socket.on('matchGo', () => (playing = true));
socket.on('matchEnd', (end) => {
  playing = false;
  console.log(`${end.result}: ${end.players.map((p) => `${p.name} ${p.score}`).join(', ')}`);
  if (autoRematch) setTimeout(() => socket.emit('rematch'), 2500);
});
socket.on('matchCancelled', () => {
  playing = false;
  readyUp();
});
socket.on('serverReset', () => {
  playing = false;
  setTimeout(readyUp, 1500);
});

setInterval(() => {
  if (!playing) return;
  typed += 1;
  const word = [...words.values()][0];
  if (typed % 6 === 0) socket.emit('submit', 'oops', () => {}); // an occasional typo, so combos break
  else if (word) socket.emit('submit', word.text, () => {});
}, everyMs);
