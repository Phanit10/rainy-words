'use strict';

// The commentator voice, with the real Kokoro model. Takes about 40 seconds.

const { URL, sleep, check, once, emitAck, startServer, player, claimOne, finish, io, tally } = require('./helpers');
const { mockApi, BASE_URL } = require('./mock-api');

function readWav(bytes) {
  const wav = Buffer.from(bytes);
  const samples = (wav.length - 44) / 2;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += (wav.readInt16LE(44 + i * 2) / 32768) ** 2;
  return {
    riff: wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE',
    pcm: wav.readUInt16LE(20) === 1,
    channels: wav.readUInt16LE(22),
    rate: wav.readUInt32LE(24),
    bits: wav.readUInt16LE(34),
    sizeOk: wav.readUInt32LE(40) === samples * 2,
    seconds: samples / wav.readUInt32LE(24),
    rms: Math.sqrt(sum / samples),
    bytes: wav.length,
  };
}

async function setup(env) {
  const server = await startServer(env);
  const a = player();
  const b = player();
  const admin = io(`${URL}/admin`, { transports: ['websocket'], forceNew: true });
  const ctx = { server, a, b, admin, adminState: null };
  admin.on('state', (s) => (ctx.adminState = s));
  await once(a.socket, 'connect');
  await emitAck(a.socket, 'join', { name: 'Alice' });
  await emitAck(b.socket, 'join', { name: 'Bob' });
  return ctx;
}

async function teardown({ server, a, b, admin }) {
  a.socket.disconnect();
  b.socket.disconnect();
  admin.disconnect();
  await server.stop();
}

async function waitForVoice(ctx, wanted, seconds = 90) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (ctx.adminState && wanted.includes(ctx.adminState.voice.state)) return;
    await sleep(200);
  }
  throw new Error(`voice never became ${wanted.join(' or ')}`);
}

async function startMatch({ a, b }) {
  const prepared = once(a.socket, 'matchPreparing');
  const go = once(a.socket, 'matchGo', 30000);
  a.socket.emit('ready', true);
  b.socket.emit('ready', true);
  const prep = await prepared;
  await go;
  return prep;
}

async function scenario(name, env, body) {
  console.log(`\n=== ${name} ===`);
  const ctx = await setup(env);
  try {
    await body(ctx);
    check(`[${name}] server stayed up without errors`, ctx.server.proc.exitCode === null && !/TypeError|Unhandled|ReferenceError/.test(ctx.server.log()));
  } catch (err) {
    tally.failed += 1;
    console.log(`FAIL  [${name}] aborted: ${err.message}\n${ctx.server.log().split('\n').slice(-12).join('\n')}`);
  }
  await teardown(ctx);
}

async function main() {
  await scenario('real Kokoro, offline commentary, theme model on too', { VOICE: '', THEME_AI: '' }, async (ctx) => {
    const { a, b } = ctx;
    await waitForVoice(ctx, ['ready']);
    check('console reports the voice is ready', ctx.adminState.voice.voice === 'af_heart', JSON.stringify(ctx.adminState.voice));

    const prep = await startMatch(ctx);
    check('clients are told a voice is available', prep.voice === true);

    // First lead, then combos at 3, 6 and 10: several major events, close together.
    const t0 = Date.now();
    let hits = 0;
    while (Date.now() - t0 < 16000) {
      await claimOne(a);
      hits += 1;
      await sleep(150);
    }
    await sleep(1500);
    const lines = a.commentary;
    check('commentary lines arrive with audio', lines.length >= 2 && lines.every((l) => l.audio), `${lines.length} lines from ${hits} hits`);
    for (const line of lines) console.log(`      "${line.text}"`);

    const wav = readWav(lines[0].audio);
    check('audio is a valid 24 kHz, 16-bit, mono PCM WAV', wav.riff && wav.pcm && wav.channels === 1 && wav.rate === 24000 && wav.bits === 16 && wav.sizeOk, `${wav.bytes} bytes`);
    check('audio has speech-length duration', wav.seconds > 0.8 && wav.seconds < 12, `${wav.seconds.toFixed(2)} s`);
    check('audio is not silent', wav.rms > 0.01, `RMS ${wav.rms.toFixed(3)}`);
    check('both players receive identical audio', b.commentary.length === lines.length && Buffer.compare(Buffer.from(b.commentary[0].audio), Buffer.from(lines[0].audio)) === 0);

    const overlaps = lines.slice(1).filter((line, i) => line.at < lines[i].at + readWav(lines[i].audio).seconds * 1000 - 100).length;
    check('a line never starts while the previous one is still being spoken', overlaps === 0, `${overlaps} overlaps`);

    const gaps = [...a.stateGaps].sort((x, y) => x - y);
    const p99 = gaps[Math.floor(gaps.length * 0.99)];
    check('the game loop stays smooth while speaking (99% of updates within 150 ms)', p99 <= 150, `median ${gaps[Math.floor(gaps.length / 2)]} ms, p99 ${p99} ms, max ${gaps.at(-1)} ms`);
    check('console counts the spoken lines', ctx.adminState.voice.lines >= lines.length, `${ctx.adminState.voice.lines} lines`);

    // The closing line is spoken too. A forfeit is the quick way to reach it.
    const closing = once(a.socket, 'commentary');
    b.socket.disconnect();
    const last = await closing;
    check('the final-whistle line is spoken', last.final === true && Boolean(last.audio), last.text);
    b.socket.connect();
    await once(b.socket, 'connect');
    await emitAck(b.socket, 'join', { name: 'Bob' });
    a.socket.emit('leaveMatch');
    await sleep(200);

    // Reset while a line is being synthesized: nothing may leak into the lobby.
    const before = a.commentary.length;
    a.socket.emit('ready', true);
    b.socket.emit('ready', true);
    await once(a.socket, 'matchGo', 30000);
    await claimOne(a);
    ctx.admin.emit('reset');
    await sleep(3500);
    check('reset during speech: the stale line is dropped', a.commentary.length === before, `${a.commentary.length - before} late lines`);
  });

  console.log('\n=== real Kokoro + LLM commentary (mock API) ===');
  const api = await mockApi('normal');
  const ctx = await setup({ VOICE: '', ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: BASE_URL });
  try {
    await waitForVoice(ctx, ['ready']);
    await startMatch(ctx);
    await claimOne(ctx.a);
    const line = await once(ctx.a.socket, 'commentary', 8000);
    check('the LLM line is what gets spoken', line.source === 'ai' && line.text === 'Alice storms ahead as Bob scrambles!' && Boolean(line.audio), `${line.audio ? readWav(line.audio).seconds.toFixed(2) : '-'} s`);
  } catch (err) {
    tally.failed += 1;
    console.log(`FAIL  aborted: ${err.message}\n${ctx.server.log().split('\n').slice(-12).join('\n')}`);
  }
  await teardown(ctx);
  await api.close();

  await scenario('voice fails to load', { VOICE: '', VOICE_NAME: 'no_such_voice', THEME_AI: '' }, async (ctx) => {
    await waitForVoice(ctx, ['failed']);
    check('console explains why the voice is off', Boolean(ctx.adminState.voice.reason), ctx.adminState.voice.reason);
    const until = Date.now() + 30000;
    while (ctx.adminState.themeAi.state === 'loading' && Date.now() < until) await sleep(200);
    check('the theme model keeps working when the voice fails', ctx.adminState.themeAi.state === 'ready', ctx.adminState.themeAi.state);
    const prep = await startMatch(ctx);
    check('clients are told there is no voice', prep.voice === false);
    await claimOne(ctx.a);
    const line = await once(ctx.a.socket, 'commentary', 5000);
    check('commentary still arrives as text', Boolean(line.text) && !line.audio, line.text);
  });

  await scenario('VOICE=off', { VOICE: 'off' }, async (ctx) => {
    await sleep(100);
    check('console shows the voice is off', ctx.adminState.voice.state === 'off');
    const prep = await startMatch(ctx);
    check('clients are told there is no voice', prep.voice === false);
    await claimOne(ctx.a);
    const line = await once(ctx.a.socket, 'commentary', 5000);
    check('commentary still arrives as text', Boolean(line.text) && !line.audio, line.text);
  });

  finish();
}

main();
