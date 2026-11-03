'use strict';

// A local stand-in for the Messages API, so the LLM path can be tested with no key and no cost.

const http = require('http');

const PORT = 3998;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recognisable fake words: they all start with q, so they can't be confused with the local word bank.
const letters = 'abcdefghijklmnopqrstuvwxyz';
function fake(len, i) {
  let word = 'q';
  let n = i * 37 + 11;
  for (let k = 1; k < len; k++) {
    word += letters[n % 26];
    n = Math.floor(n / 26) + k * 5 + i;
  }
  return word;
}
const uniq = (len, n) => [...new Set(Array.from({ length: n * 3 }, (_, i) => fake(len, i)))].slice(0, n);

const FULL = { easy: uniq(4, 30), medium: uniq(6, 30), hard: uniq(9, 34) };
// junk the server must filter out: duplicates, capitals, hyphens, digits, too short, too long
const DIRTY = {
  easy: [...FULL.easy, FULL.easy[0], 'Qzzz', 'ab', 'q-q', 'q1q2'],
  medium: [...FULL.medium, 'qqqqqqqqqqqqqq'],
  hard: [...FULL.hard, 'qxy'],
};
const FEW = { easy: FULL.easy.slice(0, 8), medium: FULL.medium.slice(0, 8), hard: FULL.hard.slice(0, 8) };

/** mode: normal | few | reject-rich (400 on optional features) | auth (401) | slow (words take 14 s) */
function mockApi(mode) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      calls.push({ url: req.url, beta: req.headers['anthropic-beta'] || '', key: req.headers['x-api-key'], body, at: Date.now() });
      const isWords = /word lists/.test(body.system);
      const fail = (status, type, message) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type, message } }));
      };
      if (mode === 'auth') return fail(401, 'authentication_error', 'invalid x-api-key');
      if (mode === 'reject-rich' && (body.fallbacks || body.output_config)) return fail(400, 'invalid_request_error', 'fallbacks: Extra inputs are not permitted');
      if (mode === 'slow' && isWords) await sleep(14000);
      const words = mode === 'few' ? FEW : DIRTY;
      const text = isWords
        ? mode === 'reject-rich' ? `Here you go:\n\`\`\`json\n${JSON.stringify(words)}\n\`\`\`` : JSON.stringify(words)
        : '"Alice storms ahead as Bob scrambles!"\nsecond line that must be dropped';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 61, output_tokens: 240 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({ calls, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { mockApi, BASE_URL, FULL, FEW };
