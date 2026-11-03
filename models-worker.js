'use strict';

/**
 * The worker thread that runs the on-device AI models; models.js starts it and talks to it.
 * Both models run on onnxruntime-node, which can only be used from one thread per process,
 * so the Kokoro voice and the theme-word model share this one worker.
 *   in:  { type: 'load', model: 'voice' | 'theme', options } | { id, kind: 'say', text } | { id, kind: 'rank', theme }
 *   out: { type: 'ready', model } | { type: 'failed', model, message } | { id, ...result } | { id, error }
 */

const { parentPort, workerData } = require('worker_threads');

const VOICE_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const THEME_MODEL = 'Xenova/all-MiniLM-L6-v2';
const SPEED = 1.1; // a little quicker than conversation: this is sports commentary
const BATCH = 256;

// An ES module. Models are kept inside the project so they survive a reinstall and work offline.
const transformers = import('@huggingface/transformers').then((lib) => {
  lib.env.cacheDir = workerData.cacheDir;
  return lib;
});

/** 16-bit PCM WAV: half the size of the float samples Kokoro returns, and every browser decodes it. */
function toWav(samples, rate) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); // format chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per sample
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return wav;
}

const handlers = {}; // request kind → async (message) => result, added as each model finishes loading

const loaders = {
  async voice({ voice }) {
    await transformers; // the cache folder is set before Kokoro loads anything
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(VOICE_MODEL, { dtype: 'q8', device: 'cpu' });
    await tts.generate('Ready.', { voice, speed: SPEED }); // so the first real line isn't the slow one
    handlers.say = async ({ text }) => {
      const { audio, sampling_rate: rate } = await tts.generate(text, { voice, speed: SPEED });
      return { wav: toWav(audio, rate), durationMs: Math.round((audio.length / rate) * 1000) };
    };
  },

  async theme({ words }) {
    const { pipeline } = await transformers;
    const embed = await pipeline('feature-extraction', THEME_MODEL, { dtype: 'q8', device: 'cpu' });
    const meaningOf = async (texts) => (await embed(texts, { pooling: 'mean', normalize: true })).tolist();

    // Each word's meaning as a vector, worked out once. The vectors have length 1, so a dot product is their similarity.
    const vectors = [];
    for (let i = 0; i < words.length; i += BATCH) vectors.push(...(await meaningOf(words.slice(i, i + BATCH))));
    handlers.rank = async ({ theme }) => {
      const [target] = await meaningOf([theme]);
      const scored = words.map((word, i) => ({ word, score: vectors[i].reduce((sum, value, k) => sum + value * target[k], 0) }));
      scored.sort((a, b) => b.score - a.score);
      return { ranked: scored.map((s) => s.word) };
    };
  },
};

parentPort.on('message', async (msg) => {
  if (msg.type === 'load') {
    try {
      await loaders[msg.model](msg.options);
      parentPort.postMessage({ type: 'ready', model: msg.model });
    } catch (err) {
      parentPort.postMessage({ type: 'failed', model: msg.model, message: err.message });
    }
    return;
  }
  try {
    parentPort.postMessage({ id: msg.id, ...(await handlers[msg.kind](msg)) });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: err.message });
  }
});
