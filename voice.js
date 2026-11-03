'use strict';

/**
 * Commentator voice: speaks each commentary line with Kokoro-82M, an open-weight text-to-speech
 * model that runs on this computer. It needs no API key, and no internet once the model is downloaded.
 *
 * The model runs in the shared model worker (models.js) so speech can never stall the 20 Hz game loop.
 * Players' browsers only receive finished audio, so the second computer needs nothing installed.
 * If the model can't load or a line fails, the commentary simply stays text-only.
 *
 * Settings (see .env.example): VOICE=off turns it off, VOICE_NAME picks the speaker.
 */

const fs = require('fs');
const path = require('path');
const models = require('./models');

const VOICE_NAME = process.env.VOICE_NAME || 'af_heart'; // Kokoro's highest-rated voice
const SAY_TIMEOUT_MS = 8_000; // a line this late is no longer play-by-play
const MODEL_FILE = path.join(__dirname, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx');

let state = process.env.VOICE === 'off' ? 'off' : 'idle'; // idle → loading → ready | failed
let reason = state === 'off' ? 'VOICE=off in .env' : null;
let log = () => {};
const usage = { lines: 0, failures: 0, lastSynthMs: null };

/** Loads the model in the background; the game is playable straight away. */
function start(logger) {
  if (state !== 'idle') return;
  log = logger;
  state = 'loading';
  const startedAt = Date.now();
  if (!fs.existsSync(MODEL_FILE)) log('[voice] downloading the Kokoro model (about 90 MB, first run only)…');
  models.load('voice', { voice: VOICE_NAME }, {
    ready: () => {
      state = 'ready';
      log(`[voice] Kokoro ready, voice ${VOICE_NAME} (loaded in ${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
    },
    failed: (message) => {
      if (state === 'failed') return;
      state = 'failed';
      reason = message;
      log(`[voice] Kokoro is unavailable (${message}); commentary stays text-only`);
    },
  });
}

/** Resolves to { wav, durationMs }, or to null when this line stays text-only. Never rejects. */
async function say(text) {
  if (state !== 'ready') return null;
  const startedAt = Date.now();
  const reply = await models.request({ kind: 'say', text }, SAY_TIMEOUT_MS);
  if (reply.error) {
    usage.failures += 1;
    log(`[voice] could not speak a line (${reply.error})`);
    return null;
  }
  usage.lines += 1;
  usage.lastSynthMs = Date.now() - startedAt;
  return { wav: Buffer.from(reply.wav), durationMs: reply.durationMs };
}

module.exports = {
  start,
  say,
  available: () => state === 'loading' || state === 'ready',
  status: () => ({ state, reason, voice: VOICE_NAME, ...usage }),
};
