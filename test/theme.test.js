'use strict';

// The AI theme words, with the real embedding model. Takes about 30 seconds.

const { URL, sleep, check, once, emitAck, startServer, player, finish, io, tally } = require('./helpers');
const { mockApi, BASE_URL } = require('./mock-api');
const pool = new Set(require('../wordpool'));

// Words a person would accept for each theme (only the ones in the pool can ever be picked).
const OCEAN = new Set('sea wave tide reef coral shell sand beach shore coast island harbor anchor sail boat ship yacht canoe kayak surf diver fish shark whale dolphin octopus squid crab lobster shrimp oyster clam seal walrus jellyfish starfish seaweed kelp lagoon bay current pearl lighthouse submarine sailor captain voyage mermaid tsunami buoy dock pier marina seagull pelican salty splash swim snorkel scuba ripple water ocean swimming surfing cruise ferry pirate treasure turtle'.split(' '));
const KITCHEN = new Set('kitchen oven stove sink fridge freezer kettle toaster blender microwave pan pot wok lid bowl plate dish cup mug glass jar fork knife spoon ladle whisk spatula grater apron napkin recipe chef cook bake boil fry roast grill chop stir slice peel cupboard counter tray bread soup salad pasta rice egg butter cheese sauce stew food meal meat oil salt'.split(' '));

/** The words that fall first: the first 8 of each length group. */
const firstToFall = (words) => ['easy', 'medium', 'hard'].flatMap((tier) => words.filter((w) => w.tier === tier).slice(0, 8).map((w) => w.text));

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

async function waitForThemeModel(ctx, seconds = 90) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (ctx.adminState && ctx.adminState.themeAi.state === 'ready') return;
    if (ctx.adminState && ctx.adminState.themeAi.state === 'failed') throw new Error(ctx.adminState.themeAi.reason);
    await sleep(200);
  }
  throw new Error('theme model never became ready');
}

/** Plays a match to its word set, then frees the arena again. */
async function matchWords(ctx) {
  const { a, b, admin } = ctx;
  const prepared = once(a.socket, 'matchPreparing');
  const started = once(a.socket, 'matchStart', 30000);
  a.socket.emit('ready', true);
  b.socket.emit('ready', true);
  const prep = await prepared;
  const start = await started;
  await sleep(150);
  const words = ctx.adminState.match.words.map((w) => ({ ...w }));
  const reset = once(a.socket, 'serverReset');
  admin.emit('reset');
  await reset;
  await sleep(150);
  return { prep, start, words };
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
  await scenario('real theme model, voice on too', { THEME_AI: '', VOICE: '' }, async (ctx) => {
    const { a, b } = ctx;
    await waitForThemeModel(ctx);
    check('console reports the theme model is ready', ctx.adminState.themeAi.words === pool.size, JSON.stringify(ctx.adminState.themeAi));

    // the lobby theme box
    a.socket.emit('setTheme', '  Ocean!!  ');
    await sleep(150);
    check('a typed theme is cleaned up and shared with every client', a.lobby.theme === 'ocean' && b.lobby.theme === 'ocean', JSON.stringify(b.lobby.theme));
    check('server terminal logs the theme change', /Alice set the theme to "ocean"/.test(ctx.server.log()));
    const stranger = player();
    await once(stranger.socket, 'lobby');
    stranger.socket.emit('setTheme', 'hacked');
    await sleep(150);
    check('a client without a nickname cannot change the theme', a.lobby.theme === 'ocean');
    stranger.socket.disconnect();

    const ocean = await matchWords(ctx);
    check('players are told the AI is picking words for their theme', ocean.prep.themeAi === true && ocean.prep.theme === 'ocean');
    check('the word set comes from the local AI model', ocean.start.source === 'local-ai' && ocean.start.theme === 'ocean', ocean.start.source);
    const set = ocean.words.map((w) => w.text);
    check('78 unique words, all from our own word pool', set.length === 78 && new Set(set).size === 78 && set.every((w) => pool.has(w)));
    const oceanFirst = firstToFall(ocean.words);
    const oceanHits = oceanFirst.filter((w) => OCEAN.has(w));
    check('most of the first words to fall fit "ocean"', oceanHits.length >= 12, `${oceanHits.length}/24: ${oceanFirst.join(' ')}`);

    a.socket.emit('setTheme', 'kitchen');
    await sleep(150);
    const kitchen = await matchWords(ctx);
    const kitchenFirst = firstToFall(kitchen.words);
    const kitchenHits = kitchenFirst.filter((w) => KITCHEN.has(w));
    check('a different theme picks different words: "kitchen"', kitchenHits.length >= 10, `${kitchenHits.length}/24: ${kitchenFirst.join(' ')}`);
    const shared = oceanFirst.filter((w) => kitchenFirst.includes(w)).length;
    check('"ocean" and "kitchen" barely share any first words', shared <= 3, `${shared} shared`);

    a.socket.emit('setTheme', 'ocean');
    await sleep(150);
    const again = await matchWords(ctx);
    const againFirst = firstToFall(again.words);
    check('a rematch on the same theme gets a fresh mix that still fits', againFirst.join() !== oceanFirst.join() && againFirst.filter((w) => OCEAN.has(w)).length >= 12);

    a.socket.emit('setTheme', 'a'.repeat(40));
    await sleep(150);
    check('a long theme is cut to 24 characters', a.lobby.theme === 'a'.repeat(24));
    a.socket.emit('setTheme', '   ');
    await sleep(150);
    check('an empty theme box means a random theme', a.lobby.theme === null);
    const random = await matchWords(ctx);
    check('a random theme is chosen and the AI still picks the words', Boolean(random.prep.theme) && random.start.source === 'local-ai', random.prep.theme);

    // spawning order: the best fits really fall first
    a.socket.emit('setTheme', 'ocean');
    await sleep(150);
    const go = once(a.socket, 'matchGo', 30000);
    a.socket.emit('ready', true);
    b.socket.emit('ready', true);
    await go;
    await sleep(3500);
    const spawned = [...a.words.values()].map((w) => w.text);
    const firstWords = firstToFall(ctx.adminState.match.words);
    check('the words that actually fall come from the front of the set', spawned.length >= 2 && spawned.every((w) => firstWords.includes(w)), spawned.join(' '));
  });

  console.log('\n=== key rejected: the local model takes over ===');
  const api = await mockApi('auth');
  const ctx = await setup({ THEME_AI: '', ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: BASE_URL });
  try {
    await waitForThemeModel(ctx);
    ctx.a.socket.emit('setTheme', 'kitchen');
    await sleep(150);
    const { prep, start } = await matchWords(ctx);
    check('with a bad key, the local AI still picks the words', prep.ai === true && start.source === 'local-ai' && start.theme === 'kitchen', start.source);
  } catch (err) {
    tally.failed += 1;
    console.log(`FAIL  aborted: ${err.message}`);
  }
  await teardown(ctx);
  await api.close();

  await scenario('THEME_AI=off', { THEME_AI: 'off' }, async (ctx) => {
    await sleep(100);
    check('console shows the theme model is off', ctx.adminState.themeAi.state === 'off');
    const { prep, start } = await matchWords(ctx);
    check('words come from the plain word bank', prep.themeAi === false && start.source === 'bank' && start.theme === 'mixed bag');
  });

  finish();
}

main();
