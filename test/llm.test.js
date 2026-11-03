'use strict';

// The LLM path against a local mock of the API: request shape, batching, validation and every
// fallback. No key and no cost. Takes about a minute.

const { spawn } = require('child_process');
const path = require('path');
const { URL, sleep, check, once, emitAck, startServer, player, claimOne, finish, io, tally } = require('./helpers');
const { mockApi, BASE_URL, FULL, FEW } = require('./mock-api');

const AI_ENV = { ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: BASE_URL };

async function scenario(mode, body) {
  console.log(`\n=== mock API mode: ${mode} ===`);
  const api = await mockApi(mode);
  const server = await startServer(AI_ENV);
  const a = player();
  const b = player();
  const admin = io(`${URL}/admin`, { transports: ['websocket'], forceNew: true });
  const ctx = { api, a, b, adminState: null, log: server.log };
  admin.on('state', (s) => (ctx.adminState = s));
  try {
    await once(a.socket, 'connect');
    await emitAck(a.socket, 'join', { name: 'Alice' });
    await emitAck(b.socket, 'join', { name: 'Bob' });
    await body(ctx);
    check(`[${mode}] server stayed up without errors`, server.proc.exitCode === null && !/TypeError|Unhandled|ReferenceError/.test(server.log()));
  } catch (err) {
    tally.failed += 1;
    console.log(`FAIL  [${mode}] aborted: ${err.message}\n${server.log().split('\n').slice(-12).join('\n')}`);
  }
  a.socket.disconnect();
  b.socket.disconnect();
  admin.disconnect();
  await server.stop();
  await api.close();
}

async function startMatch({ a, b }) {
  const prepared = once(a.socket, 'matchPreparing');
  const started = once(a.socket, 'matchStart', 30000);
  const go = once(a.socket, 'matchGo', 35000);
  a.socket.emit('ready', true);
  b.socket.emit('ready', true);
  const prep = await prepared;
  const prepAt = Date.now();
  const start = await started;
  return { prep, start, waitedMs: Date.now() - prepAt, go };
}

async function main() {
  await scenario('normal', async (ctx) => {
    const { api, a, b } = ctx;
    const { prep, start, go } = await startMatch(ctx);
    const wordCalls = () => api.calls.filter((c) => /word lists/.test(c.body.system));
    const first = wordCalls()[0];
    check('clients are told the AI is writing the words', prep.ai === true);
    check('exactly ONE word request for the whole match (bulk)', wordCalls().length === 1);
    check('request uses the configured key and default model', first.key === 'test-key-not-real' && first.body.model === 'claude-opus-5-5', first.body.model);
    check('request asks for low effort and a JSON schema', first.body.output_config?.effort === 'low' && first.body.output_config?.format?.type === 'json_schema');
    check('request opts into server-side refusal fallbacks', first.body.fallbacks === 'default' && first.beta.includes('server-side-fallback-2026-07-01') && /beta=true/.test(first.url), `${first.url} ${first.beta}`);
    check('theme chosen by the server is sent to the model', first.body.messages[0].content.includes(`Theme: ${prep.theme}.`));
    check('word prompt is compact', first.body.messages[0].content.length < 420 && first.body.system.length < 80, `${first.body.messages[0].content.length} chars`);
    check('match reports AI-written words and keeps the theme', start.source === 'ai' && start.theme === prep.theme, `${start.source} / ${start.theme}`);
    await go;
    await sleep(150);
    const set = ctx.adminState.match.words.map((w) => w.text);
    check('set is 78 unique valid words, all from the model', set.length === 78 && new Set(set).size === 78 && set.every((w) => /^q[a-z]{2,9}$/.test(w)), `${set.length}`);
    check('junk from the model is filtered (caps, hyphen, digits, too short/long, duplicates)', !set.includes('ab') && !set.includes('q-q') && !set.includes('q1q2') && !set.includes('qqqqqqqqqqqqqq') && set.filter((w) => w === FULL.easy[0]).length <= 1);
    check('words are re-bucketed by real length', ctx.adminState.match.words.every((w) => (w.text.length <= 4 ? 'easy' : w.text.length <= 6 ? 'medium' : 'hard') === w.tier));

    // A, B, B, A, A: Alice leads first (request 1, sent at once), then the lead changes twice
    // inside the 6 s cooldown, so both lead changes must ride in ONE batched request.
    const t0 = Date.now();
    for (const p of [a, b, b, a, a]) await claimOne(p);
    const burstMs = Date.now() - t0;
    await sleep(Math.max(0, 7000 - burstMs)); // let the cooldown release the batched request
    const cmt = api.calls.filter((c) => /commentator/.test(c.body.system));
    check('three lead events happened inside one cooldown window', burstMs < 5800, `${burstMs} ms`);
    check('three major events produced only two commentary requests', cmt.length === 2, `${cmt.length} requests`);
    check('second request batches several events into one', cmt[1] && (cmt[1].body.messages[0].content.split('Just happened:')[1] || '').split(';').length >= 2, cmt[1]?.body.messages[0].content.split('\n')[1]);
    check('commentary requests respect the 6 s cooldown', cmt[1] && cmt[1].at - cmt[0].at >= 5900, `${cmt[1] ? cmt[1].at - cmt[0].at : '-'} ms apart`);
    check('commentary prompt carries the live score line', /Alice \d+ \(streak \d+\) vs Bob \d+ \(streak \d+\)\. \d+s left\. Weather: \w+/.test(cmt[0].body.messages[0].content), cmt[0].body.messages[0].content.split('\n')[0]);
    check('clients receive AI commentary, first line only, quotes stripped', a.commentary.length === 2 && a.commentary.every((c) => c.source === 'ai' && c.text === 'Alice storms ahead as Bob scrambles!'), JSON.stringify(a.commentary.map((c) => c.text)));
    check('still exactly one word request', wordCalls().length === 1);
    const ai = ctx.adminState.ai;
    check('console reports usage', ai.calls === 3 && ai.words === 1 && ai.commentary === 2 && ai.inputTokens === 183 && ai.outputTokens === 720, JSON.stringify(ai));

    // npm run check:ai, against the same mock
    const out = await new Promise((resolve) => {
      const run = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-ai.js')], { env: { ...process.env, ANTHROPIC_AUTH_TOKEN: '', ...AI_ENV } });
      let text = '';
      run.stdout.on('data', (chunk) => (text += chunk));
      run.stderr.on('data', (chunk) => (text += chunk));
      run.on('close', (code) => resolve({ code, text }));
    });
    check('npm run check:ai reports a working key', out.code === 0 && /OK: the key works/.test(out.text) && /Alice storms ahead/.test(out.text), out.text.split('\n').at(-2));
  });

  await scenario('few', async (ctx) => {
    const { start, go } = await startMatch(ctx);
    await go;
    await sleep(150);
    const set = ctx.adminState.match.words.map((w) => w.text);
    const fromModel = set.filter((w) => FEW.easy.concat(FEW.medium, FEW.hard).includes(w)).length;
    check('too few words from the model: topped up from the local bank', start.source === 'ai+bank' && set.length === 78 && new Set(set).size === 78 && fromModel === 24, `${start.source}, ${set.length}`);
  });

  await scenario('reject-rich', async (ctx) => {
    const { api } = ctx;
    const { start } = await startMatch(ctx);
    check('a 400 on optional features falls back to a plain request', api.calls.length === 2 && api.calls[0].body.fallbacks === 'default' && !api.calls[1].body.fallbacks && !api.calls[1].body.output_config && !/beta=true/.test(api.calls[1].url));
    check('plain reply wrapped in prose/markdown still parses', start.source === 'ai', start.source);
  });

  await scenario('auth', async (ctx) => {
    const { api, a } = ctx;
    const { start, go } = await startMatch(ctx);
    check('rejected key: match still starts, words from the bank', start.source === 'bank' && start.theme === 'mixed bag');
    await go;
    await claimOne(a);
    await sleep(400);
    check('rejected key: commentary falls back to local lines', a.commentary.length === 1 && a.commentary[0].source === 'local', JSON.stringify(a.commentary.map((c) => c.text)));
    check('rejected key: no further requests are attempted', api.calls.length === 1, `${api.calls.length} calls`);
    check('console explains why AI is off', ctx.adminState.ai.enabled === false && /401/.test(ctx.adminState.ai.reason), ctx.adminState.ai.reason);
  });

  await scenario('slow', async (ctx) => {
    const { start, waitedMs } = await startMatch(ctx);
    check('slow model: gives up after about 12 s and uses the bank', start.source === 'bank' && waitedMs > 11500 && waitedMs < 13500, `${waitedMs} ms`);
    check('timeout is logged', /word generation failed \(timed out\)/.test(ctx.log()));
  });

  finish();
}

main();
