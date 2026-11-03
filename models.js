'use strict';

/**
 * Owns the one worker thread that runs the on-device AI models (models-worker.js). voice.js and
 * theme-words.js go through here: onnxruntime-node, which runs both models, can only be used from
 * one thread per process, so a worker per model would crash the server.
 */

const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;
let requestSeq = 0;
const waiting = new Map(); // request id → finish(reply)
const loading = new Map(); // model → { ready(), failed(message) }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'models-worker.js'), { workerData: { cacheDir: path.join(__dirname, 'models') } });
  worker.unref(); // never keeps the server alive on its own
  worker.on('message', (msg) => {
    if (msg.type === 'ready') return loading.get(msg.model)?.ready();
    if (msg.type === 'failed') return loading.get(msg.model)?.failed(msg.message);
    waiting.get(msg.id)?.(msg); // a reply that arrives after its timeout finds nobody waiting
  });
  const stopped = (message) => {
    for (const model of loading.values()) model.failed(message);
    for (const finish of waiting.values()) finish({ error: message });
  };
  worker.on('error', (err) => stopped(err.message));
  worker.on('exit', () => stopped('the model worker stopped'));
  return worker;
}

/** Loads a model in the worker, then calls ready() or failed(message). failed can also come later if the worker dies. */
function load(model, options, callbacks) {
  loading.set(model, callbacks);
  ensureWorker().postMessage({ type: 'load', model, options });
}

/** Sends one request; resolves to the worker's reply, or to { error } if it fails or times out. Never rejects. */
function request(message, timeoutMs) {
  const id = ++requestSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ error: 'timed out' }), timeoutMs);
    const finish = (reply) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(reply);
    };
    waiting.set(id, finish);
    ensureWorker().postMessage({ ...message, id });
  });
}

module.exports = { load, request };
