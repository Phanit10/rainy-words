'use strict';

// The game rules, end to end: two real socket clients against the real server. Takes about 1.5 minutes.

const { URL, sleep, check, once, emitAck, startServer, player, finish, io, tally } = require('./helpers');

async function main() {
  const server = await startServer();
  try {
    /* ── connect, lobby info, nickname, welcome ─────────────────────────── */
    const a = player();
    await once(a.socket, 'lobby');
    check('client receives lobby info right after connecting (before nickname)', a.lobby.online === 1);

    const b = player();
    await once(b.socket, 'lobby');
    await sleep(100);
    check('existing client is told about the newly connected client', a.lobby.online === 2);

    const ja = await emitAck(a.socket, 'join', { name: '  Alice  ' });
    check('nickname accepted and welcome message is "Welcome, Alice."', ja.ok && ja.welcome === 'Welcome, Alice.', JSON.stringify(ja));
    const dup = await emitAck(b.socket, 'join', { name: 'alice' });
    check('duplicate nickname is rejected', dup.ok === false, dup.error);
    const empty = await emitAck(b.socket, 'join', { name: '   ' });
    check('empty nickname is rejected', empty.ok === false);
    const jb = await emitAck(b.socket, 'join', { name: 'Bob' });
    check('second player joins, welcome "Welcome, Bob."', jb.ok && jb.welcome === 'Welcome, Bob.');
    await sleep(100);
    check('each client sees the other connected client by name', a.lobby.players.some((p) => p.name === 'Bob') && b.lobby.players.some((p) => p.name === 'Alice'));

    /* ── server console ─────────────────────────────────────────────────── */
    const admin = io(`${URL}/admin`, { transports: ['websocket'], forceNew: true });
    let adminState = await once(admin, 'state');
    admin.on('state', (s) => (adminState = s));
    check('console shows number of concurrent clients', adminState.online === 2, `online=${adminState.online}`);
    check('console lists the connected clients by name', ['Alice', 'Bob'].every((n) => adminState.clients.some((c) => c.name === n)));
    check('server terminal prints client count and list', /\[clients\] 2 connected: Alice, Bob/.test(server.log()));

    /* ── start a storm match ────────────────────────────────────────────── */
    a.socket.emit('ready', true);
    await sleep(100);
    check('one ready player does not start a match', !a.events.some(([e]) => e === 'matchPreparing'));
    b.socket.emit('ready', true);
    const prep = await once(a.socket, 'matchPreparing');
    const start = await once(a.socket, 'matchStart');
    check('matchStart carries a 60 000 ms duration and a 3 s countdown', start.durationMs === 60000 && start.countdownMs === 3000);
    check('storm mode exposes combo steps', JSON.stringify(start.combo) === '[[3,2],[6,3],[10,4]]');
    await once(a.socket, 'matchGo');
    const goAt = Date.now();
    await sleep(200);
    const set1 = adminState.match.words.map((w) => w.text);
    check('console shows the word set of the current match', set1.length >= 70, `${set1.length} words`);
    check('word set is unique', new Set(set1).size === set1.length);
    check('every word is a-z, 3-10 letters', set1.every((w) => /^[a-z]{3,10}$/.test(w)));
    check('server terminal prints the word set', new RegExp(`\\[match ${prep.matchId}\\] word set \\(${set1.length} unique`).test(server.log()));
    check('both clients have the same falling words', a.words.size > 0 && [...a.words.keys()].join() === [...b.words.keys()].join());

    /* ── simultaneous claim ─────────────────────────────────────────────── */
    const target = [...a.words.values()][0];
    const [ra, rb] = await Promise.all([emitAck(a.socket, 'submit', target.text), emitAck(b.socket, 'submit', target.text)]);
    const results = [ra.result, rb.result].sort().join('+');
    check('same word, same instant: exactly one player scores, the other is "late"', results === 'hit+late', results);
    await sleep(80);
    check('claimed word disappears from BOTH clients', !a.words.has(target.id) && !b.words.has(target.id) && a.claimed.length === 1 && b.claimed.length === 1);
    const winner = ra.result === 'hit' ? a : b;
    const loser = winner === a ? b : a;
    check('first correct word is worth exactly 1 point', a.stats[winner.socket.id].score === 1 && a.stats[loser.socket.id].score === 0);
    check('"late" does not count as a typo', a.stats[loser.socket.id].misses === 0 && a.stats[loser.socket.id].accuracy === null);

    /* ── typo: accuracy + streak ────────────────────────────────────────── */
    const miss = await emitAck(loser.socket, 'submit', 'zzzzqq');
    await sleep(50);
    check('wrong word is a miss and drops accuracy to 0%', miss.result === 'miss' && a.stats[loser.socket.id].accuracy === 0);
    const upper = [...a.words.values()][0];
    const up = await emitAck(winner.socket, 'submit', `  ${upper.text.toUpperCase()} `);
    check('submission is case-insensitive and trimmed', up.result === 'hit');

    /* ── combo multipliers: the winner types everything for a while ─────── */
    const pointsSeen = [1, up.points];
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const w = [...winner.words.values()][0];
      if (w) {
        const r = await emitAck(winner.socket, 'submit', w.text);
        if (r.result === 'hit') pointsSeen.push(r.points);
      }
      await sleep(120);
    }
    const expected = pointsSeen.map((_, i) => (i + 1 >= 10 ? 4 : i + 1 >= 6 ? 3 : i + 1 >= 3 ? 2 : 1));
    check('combo multiplier: x1,x1,x2 from 3 in a row, x3 from 6, x4 from 10', pointsSeen.length >= 10 && pointsSeen.join() === expected.join(), pointsSeen.join(','));
    check('score equals the sum of awarded points', winner.stats[winner.socket.id].score === pointsSeen.reduce((s, n) => s + n, 0));
    check('difficulty went UP after accurate play', winner.difficulty.some((d) => d.dir === 'up'), JSON.stringify(winner.difficulty));
    check('weather fronts were broadcast', winner.weather.length >= 2, winner.weather.map((w) => w.key).join(','));
    check('wind physically moves words sideways', winner.maxAbsVx > 0.002, `max |vx| = ${winner.maxAbsVx}`); // weather is random: light fronts only reach about 0.01
    check('local commentator spoke on major events', winner.commentary.length >= 2, winner.commentary.map((c) => c.text).join(' | '));
    const levelAfterUp = Math.max(...winner.difficulty.map((d) => d.level));

    /* ── break the combo, then tank accuracy → difficulty should fall ───── */
    const brk = await emitAck(winner.socket, 'submit', 'qqqq');
    check('typo resets the streak and reports what was lost', brk.result === 'miss' && brk.lost >= 10, JSON.stringify(brk));
    await sleep(50);
    check('multiplier is back to x1 after the typo', winner.stats[winner.socket.id].streak === 0 && winner.stats[winner.socket.id].mult === 1);
    const t1 = Date.now();
    let n = 0;
    while (Date.now() - t1 < 17000) {
      await emitAck(winner.socket, 'submit', `xx${'abcdefghij'[n++ % 10]}x`);
      await emitAck(loser.socket, 'submit', `yy${'abcdefghij'[n % 10]}y`);
      await sleep(400);
    }
    check('difficulty went DOWN after inaccurate play or dropped words', winner.difficulty.some((d) => d.dir === 'down'), JSON.stringify(winner.difficulty.slice(-3)));
    check('words that reach the ground disappear from both clients', a.gone.length > 0 && a.gone.length === b.gone.length, `${a.gone.length} dropped`);
    check('level stayed within 1..5', winner.difficulty.every((d) => d.level >= 1 && d.level <= 5) && levelAfterUp <= 5);

    /* ── the end of the match ───────────────────────────────────────────── */
    const [ea, eb] = await Promise.all([once(a.socket, 'matchEnd', 40000), once(b.socket, 'matchEnd', 40000)]);
    const duration = Date.now() - goAt;
    check('match lasts exactly one minute (within 150 ms as seen by a client)', Math.abs(duration - 60000) <= 150, `${duration} ms`);
    check('one player gets "Win", the other "Lost"', [ea.result, eb.result].sort().join() === 'Lost,Win', `${ea.result}/${eb.result}`);
    check('final scores of both players are included', ea.players.length === 2 && ea.players.every((p) => typeof p.score === 'number'));
    check('rematch is offered', ea.canRematch === true);
    const late = await emitAck(a.socket, 'submit', 'rain');
    check('submissions after the final whistle are ignored', late.result === 'idle');
    await sleep(300);
    check('closing commentary line arrives after the match', a.commentary.some((c) => c.final));
    const winsRow = () => a.lobby.players.map((p) => `${p.name}:${p.wins}`).sort().join();
    check('winner gets a win on the lobby board', /:1/.test(winsRow()), winsRow());

    /* ── rematch needs both ─────────────────────────────────────────────── */
    a.socket.emit('rematch');
    const rs = await once(b.socket, 'rematchStatus');
    check('one vote does not start the rematch', rs.agreed.length === 1 && !a.events.slice(-1).some(([e]) => e === 'matchPreparing'));
    b.socket.emit('rematch');
    const prep2 = await once(a.socket, 'matchPreparing');
    await once(a.socket, 'matchGo');
    await sleep(200);
    const set2 = adminState.match.words.map((w) => w.text);
    check('rematch starts a new match id', prep2.matchId === prep.matchId + 1);
    check('rematch has a freshly generated word set', set2.join() !== set1.join() && new Set(set2).size === set2.length, `${set2.length} words`);
    check('scores start at zero in the rematch', adminState.match.players.every((p) => p.score === 0));

    /* ── server reset mid-match ─────────────────────────────────────────── */
    const w2 = [...a.words.values()][0];
    await emitAck(a.socket, 'submit', w2.text);
    await sleep(100);
    check('score is 1 before reset', adminState.match.players.some((p) => p.score === 1));
    const resets = [once(a.socket, 'serverReset'), once(b.socket, 'serverReset')];
    admin.emit('reset');
    await Promise.all(resets);
    await sleep(200);
    check('reset: the match is gone', adminState.match === null);
    check('reset: every score and win count is zero', adminState.clients.every((c) => c.wins === 0 && c.score === null));
    check('reset: players are back in the lobby and still connected', a.lobby.players.length === 2 && a.lobby.players.every((p) => p.status === 'lobby' && !p.ready));
    const statesBefore = a.states;
    await sleep(300);
    check('reset: the old match stopped ticking', a.states === statesBefore);

    /* ── classic mode: exactly one point per word, no wind, no scaling ──── */
    a.socket.emit('setMode', 'classic');
    await sleep(100);
    check('mode switch is shared with every client', b.lobby.mode === 'classic');
    a.difficulty.length = 0;
    a.weather.length = 0;
    a.maxAbsVx = 0;
    a.socket.emit('ready', true);
    b.socket.emit('ready', true);
    const start3 = await once(a.socket, 'matchStart');
    await once(a.socket, 'matchGo');
    check('classic mode has no combo steps', start3.mode === 'classic' && start3.combo.length === 0);
    const classicPoints = [];
    const t2 = Date.now();
    while (Date.now() - t2 < 11000) {
      const w = [...a.words.values()][0];
      if (w) {
        const r = await emitAck(a.socket, 'submit', w.text);
        if (r.result === 'hit') classicPoints.push(r.points);
      }
      await sleep(150);
    }
    check('classic: every word is worth exactly 1 point, however long the streak', classicPoints.length >= 4 && classicPoints.every((p) => p === 1), classicPoints.join(','));
    check('classic: no wind, no weather fronts, no difficulty changes', a.maxAbsVx === 0 && a.weather.length === 0 && a.difficulty.length === 0);

    /* ── a third client is told a match is running ──────────────────────── */
    const c = player();
    await once(c.socket, 'lobby');
    await emitAck(c.socket, 'join', { name: 'Cara' });
    await sleep(100);
    check('third client sees who is playing', c.lobby.match && c.lobby.match.players.join() === 'Alice,Bob', JSON.stringify(c.lobby.match));
    check('third client receives no match traffic', c.states === 0 && c.words.size === 0);
    const cheat = await emitAck(c.socket, 'submit', [...a.words.values()][0]?.text || 'rain');
    check('a non-player cannot score', cheat.result === 'idle');

    /* ── opponent disconnects mid-match ─────────────────────────────────── */
    const endForfeit = once(a.socket, 'matchEnd');
    b.socket.disconnect();
    const ef = await endForfeit;
    check('disconnect mid-match: remaining player wins by forfeit, no rematch', ef.result === 'Win' && ef.reason === 'forfeit' && ef.canRematch === false);
    await sleep(100);
    check('console count drops when a client disconnects', adminState.online === 2, `online=${adminState.online}`);
    a.socket.emit('leaveMatch');
    await sleep(100);
    check('leaving the results screen frees the arena', adminState.match === null && a.lobby.players.find((p) => p.name === 'Alice').status === 'lobby');

    /* ── disconnect during the countdown cancels cleanly ────────────────── */
    a.socket.emit('ready', true);
    c.socket.emit('ready', true);
    await once(a.socket, 'matchStart');
    const cancelled = once(a.socket, 'matchCancelled');
    c.socket.disconnect();
    await cancelled;
    await sleep(100);
    check('disconnect during countdown cancels the match and returns the other player to the lobby', adminState.match === null && a.lobby.players[0].status === 'lobby');

    a.socket.disconnect();
    admin.disconnect();
    await sleep(200);
    check('server never crashed or logged an error', server.proc.exitCode === null && !/Error|TypeError|Unhandled/.test(server.log()));
  } catch (err) {
    tally.failed += 1;
    console.log(`FAIL  test run aborted: ${err.message}\n\n--- server log tail ---\n${server.log().split('\n').slice(-25).join('\n')}`);
  }
  await server.stop();
  finish();
}

main();
