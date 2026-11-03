'use strict';

/**
 * AI theme words: picks the words that fit a match's theme using all-MiniLM-L6-v2, a small sentence-embedding
 * model (about 25 MB) that runs on this computer. It's free, and works offline once downloaded.
 *
 * The model turns the theme and every word in wordpool.js into meaning vectors, and the words whose meaning is
 * closest to the theme win. Every word comes from our own list, so nothing misspelled or offensive can appear.
 *
 * Like the voice, the model runs in the shared model worker (models.js) so it never stalls the game loop.
 * If it can't load, matches use the plain word bank instead. THEME_AI=off in .env turns it off.
 */

const fs = require('fs');
const path = require('path');
const models = require('./models');
const pool = require('./wordpool');

const RANK_TIMEOUT_MS = 5_000;
const MODEL_FILE = path.join(__dirname, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');

let state = process.env.THEME_AI === 'off' ? 'off' : 'idle'; // idle → loading → ready | failed
let reason = state === 'off' ? 'THEME_AI=off in .env' : null;
let log = () => {};
const usage = { words: pool.length, themes: 0, failures: 0, lastRankMs: null };

/** Loads the model and reads the whole word pool in the background; the game is playable straight away. */
function start(logger) {
  if (state !== 'idle') return;
  log = logger;
  state = 'loading';
  const startedAt = Date.now();
  if (!fs.existsSync(MODEL_FILE)) log('[theme-ai] downloading the theme model (about 25 MB, first run only)…');
  models.load('theme', { words: pool }, {
    ready: () => {
      state = 'ready';
      log(`[theme-ai] theme model ready, ${pool.length} words read (in ${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
    },
    failed: (message) => {
      if (state === 'failed') return;
      state = 'failed';
      reason = message;
      log(`[theme-ai] the theme model is unavailable (${message}); matches use the word bank`);
    },
  });
}

/** Resolves to every pool word, closest to the theme first, or to null when the word bank must be used. Never rejects. */
async function rank(theme) {
  if (state !== 'ready') return null;
  const startedAt = Date.now();
  const reply = await models.request({ kind: 'rank', theme }, RANK_TIMEOUT_MS);
  if (reply.error) {
    usage.failures += 1;
    log(`[theme-ai] could not rank words (${reply.error})`);
    return null;
  }
  usage.themes += 1;
  usage.lastRankMs = Date.now() - startedAt;
  return reply.ranked;
}

module.exports = {
  start,
  rank,
  available: () => state === 'loading' || state === 'ready',
  status: () => ({ state, reason, ...usage }),
};
