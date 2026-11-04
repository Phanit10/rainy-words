/* Rainy Words — browser client. The server owns every piece of game state; this file draws it and sends what the player types. */
(() => {
  'use strict';

  // Hardcoded in config.js — players never type an address.
  const { SERVER_HOST, SERVER_PORT } = window.RAINY_CONFIG;
  const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const GROUND = 36; // px, height of the wet street at the bottom of the field

  let socket = null;
  let me = null; // { id, name } once the server accepts the nickname
  let lobby = { online: 0, players: [], mode: 'storm', match: null };
  let game = null; // the match this client is playing, or null
  const words = new Map(); // id → falling word
  const sky = { wind: 0.12, rain: 0.35, shownWind: 0.12, shownRain: 0.35 };
  const field = { el: $('field'), w: 0, h: 0 };

  const typeEl = $('type');
  const dock = $('dock');

  /* ── Small UI helpers ──────────────────────────────────────────────────── */

  function show(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('is-active', el.id === `screen-${name}`);
    document.body.classList.toggle('in-game', name === 'game'); // the match has its own city inside the field
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(text) {
    const node = el('div', 'toast', text);
    $('toasts').append(node);
    setTimeout(() => node.classList.add('is-out'), 3200);
    setTimeout(() => node.remove(), 3600);
  }

  function replay(node, className) {
    node.classList.remove(className);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(className);
  }

  function setConn(state, text) {
    $('conn').dataset.state = state;
    $('conn-text').textContent = text;
    const up = state === 'up';
    $('nick').disabled = !up;
    $('join-btn').disabled = !up;
  }

  let bannerTimer = null;
  function banner(text, kind) {
    const node = $('banner');
    node.textContent = text;
    node.dataset.kind = kind;
    node.classList.add('is-on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => node.classList.remove('is-on'), 2400);
  }

  let noteTimer = null;
  function note(text) {
    const node = $('type-note');
    node.textContent = text;
    node.classList.add('is-on');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => node.classList.remove('is-on'), 1400);
  }

  /* ── Commentator voice ─────────────────────────────────────────────────── */

  // Browsers keep sound locked until the page gets a click or a key press, so unlock on the first one.
  let audioCtx = null;
  let speaking = null; // the line being played right now
  let speechSeq = 0;
  let voiceOn = true;
  try {
    voiceOn = localStorage.getItem('rainy-voice') !== 'off';
  } catch {
    /* storage blocked: the voice just stays on */
  }

  function unlockAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    startSound();
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  function stopVoice() {
    speechSeq += 1;
    if (speaking) {
      speaking.onended = null;
      speaking.stop();
      speaking = null;
    }
    $('booth').classList.remove('is-speaking');
  }

  async function playVoice(bytes) {
    stopVoice(); // the server paces the lines, so this only cuts in for the final whistle
    const seq = speechSeq;
    if (!voiceOn || !audioCtx || document.hidden) return; // two tabs on one computer would echo: only the one in view speaks
    let sound;
    try {
      sound = await audioCtx.decodeAudioData(bytes);
    } catch {
      return; // the line is still on screen as text
    }
    if (seq !== speechSeq) return; // a newer line arrived while this one was decoding
    speaking = audioCtx.createBufferSource();
    speaking.buffer = sound;
    speaking.connect(audioCtx.destination);
    speaking.onended = () => {
      speaking = null;
      $('booth').classList.remove('is-speaking');
    };
    speaking.start();
    $('booth').classList.add('is-speaking');
  }

  function renderVoiceButton() {
    const button = $('voice-btn');
    button.textContent = voiceOn ? 'Voice on' : 'Voice off';
    button.setAttribute('aria-pressed', String(voiceOn));
  }

  $('voice-btn').addEventListener('click', () => {
    voiceOn = !voiceOn;
    try {
      localStorage.setItem('rainy-voice', voiceOn ? 'on' : 'off');
    } catch {
      /* the choice just won't be remembered */
    }
    if (!voiceOn) stopVoice();
    renderVoiceButton();
    if (game && game.phase === 'playing') typeEl.focus();
  });
  renderVoiceButton();

  /* ── Sound effects ─────────────────────────────────────────────────────── */

  // Every sound is generated here with the Web Audio API, so there are no sound files to download or lose.
  let soundOn = true;
  try {
    soundOn = localStorage.getItem('rainy-sound') !== 'off';
  } catch {
    /* storage blocked: sound just stays on */
  }
  let master = null; // effects and the rain go through this, so one switch mutes them (the voice has its own)
  let rainGain = null;
  let noise = null; // two seconds of white noise, reused by every noisy sound
  let ambienceAt = 0;

  function startSound() {
    if (master) return;
    master = audioCtx.createGain();
    master.connect(audioCtx.destination);
    applySoundSwitch();
    noise = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

    // rain on the roof: looping noise, softened; its volume follows the weather in frame()
    const rain = audioCtx.createBufferSource();
    rain.buffer = noise;
    rain.loop = true;
    const high = audioCtx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 400;
    const low = audioCtx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 2600;
    rainGain = audioCtx.createGain();
    rainGain.gain.value = 0;
    rain.connect(high).connect(low).connect(rainGain).connect(master);
    rain.start();
  }

  function applySoundSwitch() {
    if (master) master.gain.setTargetAtTime(soundOn && !document.hidden ? 1 : 0, audioCtx.currentTime, 0.05);
  }
  document.addEventListener('visibilitychange', applySoundSwitch); // two tabs on one computer: only the one in view makes sound

  function tone(freq, at, length, { type = 'sine', volume = 0.15, slideTo = null } = {}) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  function hiss(at, length, { filter = 'bandpass', freq = 1000, slideTo = null, volume = 0.1, attack = 0.005 } = {}) {
    const src = audioCtx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const shape = audioCtx.createBiquadFilter();
    shape.type = filter;
    shape.frequency.setValueAtTime(freq, at);
    if (slideTo) shape.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(shape).connect(gain).connect(master);
    src.start(at, Math.random() * 1.5);
    src.stop(at + length + 0.05);
  }

  const SOUNDS = {
    key: (t) => hiss(t, 0.035, { filter: 'highpass', freq: 3000, volume: 0.035 }),
    score: (t) => {
      tone(880, t, 0.12, { type: 'triangle', volume: 0.12 });
      tone(1320, t + 0.06, 0.2, { type: 'triangle', volume: 0.12 });
    },
    rival: (t) => tone(392, t, 0.16, { type: 'triangle', volume: 0.07, slideTo: 330 }),
    miss: (t) => tone(150, t, 0.2, { type: 'square', volume: 0.05, slideTo: 90 }),
    typo: (t) => tone(220, t, 0.08, { type: 'square', volume: 0.0525, slideTo: 160 }),
    click: (t) => {
      tone(1200, t, 0.04, { type: 'triangle', volume: 0.075, slideTo: 800 });
      hiss(t, 0.03, { filter: 'highpass', freq: 4000, volume: 0.0375 });
    },
    splash: (t) => {
      tone(1100, t, 0.12, { volume: 0.05, slideTo: 260 });
      hiss(t, 0.18, { freq: 1800, volume: 0.04 });
    },
    combo: (t) => [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.07, 0.3, { type: 'triangle', volume: 0.1 })),
    thunder: (t) => {
      hiss(t + 0.2, 0.4, { filter: 'lowpass', freq: 900, volume: 0.25 });
      hiss(t + 0.25, 2.6, { filter: 'lowpass', freq: 220, slideTo: 60, volume: 0.6, attack: 0.08 });
    },
    whoosh: (t) => hiss(t, 0.7, { freq: 300, slideTo: 2600, volume: 0.12, attack: 0.25 }),
    zap: (t) => {
      tone(1800, t, 0.25, { type: 'sawtooth', volume: 0.05, slideTo: 120 });
      hiss(t, 0.2, { filter: 'highpass', freq: 2000, volume: 0.08 });
    },
    beep: (t) => tone(660, t, 0.14, { type: 'square', volume: 0.05 }),
    go: (t) => {
      tone(990, t, 0.35, { type: 'square', volume: 0.06 });
      tone(1485, t, 0.35, { type: 'triangle', volume: 0.05 });
    },
    tick: (t) => tone(1500, t, 0.05, { type: 'square', volume: 0.025 }),
    win: (t) => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.09, 0.45, { type: 'triangle', volume: 0.1 })),
    lost: (t) => [392, 349, 311, 262].forEach((f, i) => tone(f, t + i * 0.14, 0.4, { type: 'triangle', volume: 0.08 })),
  };

  function sound(name) {
    if (!soundOn || !master || audioCtx.state !== 'running' || document.hidden) return;
    SOUNDS[name](audioCtx.currentTime + 0.005);
  }

  /** The rain's volume follows the weather, and drops while the commentator speaks. */
  function updateAmbience(now) {
    if (!rainGain || now - ambienceAt < 250) return;
    ambienceAt = now;
    const level = (0.025 + sky.shownRain * 0.08) * (speaking ? 0.45 : 1);
    rainGain.gain.setTargetAtTime(level, audioCtx.currentTime, 0.4);
  }

  function renderSoundButtons() {
    for (const button of document.querySelectorAll('[data-sound-toggle]')) {
      button.textContent = soundOn ? 'Sound on' : 'Sound off';
      button.setAttribute('aria-pressed', String(soundOn));
    }
  }

  for (const button of document.querySelectorAll('[data-sound-toggle]')) {
    button.addEventListener('click', () => {
      soundOn = !soundOn;
      try {
        localStorage.setItem('rainy-sound', soundOn ? 'on' : 'off');
      } catch {
        /* the choice just won't be remembered */
      }
      applySoundSwitch();
      renderSoundButtons();
      if (game && game.phase === 'playing') typeEl.focus();
    });
  }
  renderSoundButtons();

  // Every button clicks. This runs after the button's own handler, so switching sound off stays silent.
  document.addEventListener('click', (event) => {
    if (event.target.closest('button:not(:disabled)')) sound('click');
  });

  /* ── Neon city ─────────────────────────────────────────────────────────── */

  const NEON = ['#ff3df2', '#22e3ff', '#ffc23d', '#b18cff', '#3dffa2'];

  /** A small seeded random generator, so the skyline keeps its shape on every redraw. */
  function seeded(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /**
   * Draws three layers of buildings standing on a street at `streetTop`, with lit windows, neon signs,
   * and the wet street reflecting the signs. Redrawn on resize, and every few seconds so a few windows
   * switch on and off; the shapes stay put because they come from the seeded generator.
   */
  function drawCity(canvas, streetTop, skyHeight, seed) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const street = c.createLinearGradient(0, streetTop, 0, h); // wet asphalt, lit from above
    street.addColorStop(0, '#160c34');
    street.addColorStop(1, '#05030f');
    c.fillStyle = street;
    c.fillRect(0, streetTop, w, h - streetTop);
    c.fillStyle = 'rgba(34, 227, 255, 0.35)';
    c.fillRect(0, streetTop, w, 1);
    const random = seeded(seed);
    const signs = [];
    const layers = [
      { tall: [0.25, 0.55], fill: '#170c36', windows: 0.07, widths: [50, 110], signs: 0 }, // far: low and hazy
      { tall: [0.35, 0.8], fill: '#0e0726', windows: 0.13, widths: [40, 90], signs: 0.12 },
      { tall: [0.4, 1], fill: '#06031a', windows: 0.2, widths: [34, 80], signs: 0.35 }, // near: tallest and darkest
    ];
    for (const layer of layers) {
      let x = -random() * 30;
      while (x < w) {
        const bw = layer.widths[0] + random() * (layer.widths[1] - layer.widths[0]);
        const bh = skyHeight * (layer.tall[0] + random() * (layer.tall[1] - layer.tall[0]));
        const top = streetTop - bh;
        c.fillStyle = layer.fill;
        c.fillRect(x, top, bw - 2, bh);
        if (random() < 0.3) c.fillRect(x + bw * 0.3, top - 10, 3, 10); // antenna
        for (let wy = top + 8; wy < streetTop - 8; wy += 9) {
          for (let wx = x + 5; wx < x + bw - 8; wx += 8) {
            const lit = random() < layer.windows;
            const warm = random() < 0.75;
            if (!lit || Math.random() < 0.04) continue; // the only thing that changes between redraws
            c.fillStyle = warm ? 'rgba(255, 214, 140, 0.5)' : 'rgba(140, 230, 255, 0.45)';
            c.fillRect(wx, wy, 3, 4);
          }
        }
        if (random() < layer.signs && bh > skyHeight * 0.4) {
          signs.push({ x: x + bw / 2, y: top + 12 + random() * 18, color: NEON[Math.floor(random() * NEON.length)], tall: random() < 0.5, bw });
        }
        x += bw;
      }
    }
    for (const sign of signs) {
      c.shadowColor = sign.color;
      c.shadowBlur = 16;
      c.fillStyle = sign.color;
      if (sign.tall) c.fillRect(sign.x - 3, sign.y, 6, 34);
      else c.fillRect(sign.x - sign.bw * 0.3, sign.y, sign.bw * 0.6, 5);
    }
    c.shadowBlur = 0;
    for (const sign of signs) {
      // the wet street stretches each sign into a long reflection
      const streak = c.createLinearGradient(0, streetTop, 0, h);
      streak.addColorStop(0, withAlpha(sign.color, 0.5));
      streak.addColorStop(1, withAlpha(sign.color, 0));
      c.fillStyle = streak;
      const width = sign.tall ? 6 : sign.bw * 0.3;
      c.fillRect(sign.x - width / 2, streetTop, width, h - streetTop);
    }
  }

  const skyline = $('skyline');
  const drawSkyline = () => drawCity(skyline, skyline.clientHeight - 40, skyline.clientHeight - 60, 3);
  const drawFieldCity = () => drawCity($('city'), field.h - GROUND, (field.h - GROUND) * 0.55, 11);
  window.addEventListener('resize', drawSkyline);
  drawSkyline();
  setInterval(() => (document.body.classList.contains('in-game') ? drawFieldCity() : drawSkyline()), 2500);

  let flashTimer = null;
  let litTimer = null;
  function lightning() {
    sound('thunder');
    if (reducedMotion) return;
    document.body.classList.add('flash');
    field.el.classList.add('is-lit');
    clearTimeout(flashTimer);
    clearTimeout(litTimer);
    litTimer = setTimeout(() => field.el.classList.remove('is-lit'), 160);
    flashTimer = setTimeout(() => document.body.classList.remove('flash'), 560);
  }

  /* ── Effects: neon bursts and street splashes ──────────────────────────── */

  const fx = { canvas: $('fx'), parts: [], rings: [], dirty: false };
  fx.c = fx.canvas.getContext('2d');

  function sizeFx() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    fx.canvas.width = Math.round(field.w * dpr);
    fx.canvas.height = Math.round(field.h * dpr);
    fx.c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** A claimed word shatters into sparks of the claimer's colour. */
  function burst(x, y, color) {
    for (let i = 0; i < (reducedMotion ? 6 : 24); i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 260;
      fx.parts.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 120, life: 0.5 + Math.random() * 0.4, age: 0, r: 1.5 + Math.random() * 2.5, color });
    }
  }

  /** A word that reaches the street leaves a ripple and a few droplets. */
  function splash(x) {
    const y = field.h - GROUND + 14;
    fx.rings.push({ x, y, age: 0, life: 0.8 });
    for (let i = 0; i < (reducedMotion ? 3 : 10); i++) {
      fx.parts.push({ x, y: y - 6, vx: (Math.random() - 0.5) * 160, vy: -80 - Math.random() * 180, life: 0.5, age: 0, r: 1.2 + Math.random() * 1.6, color: '#9fdcff' });
    }
  }

  function drawFx(dt) {
    const { c } = fx;
    if (!fx.parts.length && !fx.rings.length) {
      if (fx.dirty) c.clearRect(0, 0, field.w, field.h);
      fx.dirty = false;
      return;
    }
    fx.dirty = true;
    c.clearRect(0, 0, field.w, field.h);
    c.globalCompositeOperation = 'lighter';
    fx.parts = fx.parts.filter((p) => (p.age += dt) < p.life);
    for (const p of fx.parts) {
      p.vy += 620 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      c.globalAlpha = 1 - p.age / p.life;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c.fill();
    }
    fx.rings = fx.rings.filter((r) => (r.age += dt) < r.life);
    c.strokeStyle = '#9fdcff';
    c.lineWidth = 1.5;
    for (const r of fx.rings) {
      const t = r.age / r.life;
      c.globalAlpha = (1 - t) * 0.8;
      c.beginPath();
      c.ellipse(r.x, r.y, 8 + t * 46, 2 + t * 8, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /* ── Connection ────────────────────────────────────────────────────────── */

  // The Socket.IO client library is served by the game server itself, so it always matches the server's version.
  function boot() {
    const tag = document.createElement('script');
    tag.src = `${SERVER_URL}/socket.io/socket.io.js`;
    tag.onload = connect;
    tag.onerror = () => {
      tag.remove();
      setConn('down', `No answer from ${SERVER_HOST}:${SERVER_PORT}. Retrying…`);
      setTimeout(boot, 2000);
    };
    document.head.append(tag);
  }

  function connect() {
    socket = window.io(SERVER_URL);

    socket.on('connect', () => {
      setConn('up', `Connected to ${SERVER_HOST}:${SERVER_PORT}`);
      if (me) join(me.name); // the connection dropped and came back: rejoin under the same nickname
      else $('nick').focus();
    });
    socket.on('disconnect', () => {
      setConn('down', 'Connection lost. Reconnecting…');
      leaveGame();
      show('join');
    });
    socket.on('connect_error', () => setConn('down', `No answer from ${SERVER_HOST}:${SERVER_PORT}. Retrying…`));

    socket.on('lobby', (data) => {
      lobby = data;
      renderLobby();
    });
    socket.on('matchPreparing', onPreparing);
    socket.on('matchStart', onMatchStart);
    socket.on('matchGo', onGo);
    socket.on('state', onState);
    socket.on('wordSpawn', addWord);
    socket.on('wordClaimed', onClaimed);
    socket.on('wordGone', onGone);
    socket.on('stats', (data) => game && setStats(data.stats));
    socket.on('weather', onWeather);
    socket.on('difficulty', onDifficulty);
    socket.on('commentary', onCommentary);
    socket.on('matchEnd', onMatchEnd);
    socket.on('rematchStatus', onRematchStatus);
    socket.on('opponentLeft', onOpponentLeft);
    socket.on('matchCancelled', (data) => backToLobby(data.message));
    socket.on('serverReset', (data) => backToLobby(data.message));
  }

  function join(name) {
    socket.emit('join', { name }, (res) => {
      if (!res.ok) {
        me = null;
        $('join-error').textContent = res.error;
        show('join');
        return;
      }
      me = { id: res.id, name: res.name };
      $('join-error').textContent = '';
      $('welcome').textContent = res.welcome; // "Welcome, Alice."
      toast(res.welcome);
      show('lobby');
      renderLobby();
    });
  }

  function backToLobby(message) {
    leaveGame();
    if (!me) return;
    show('lobby');
    if (message) toast(message);
  }

  /* ── Lobby ─────────────────────────────────────────────────────────────── */

  const STATUS = { lobby: 'In lobby', playing: 'Playing', results: 'Results' };

  function renderLobby() {
    $('join-count').textContent = lobby.online;
    $('lobby-count').textContent = lobby.online;

    // Join screen: who is already here
    const chips = lobby.players.map((p) => el('li', '', p.name));
    $('join-list').replaceChildren(...(chips.length ? chips : [el('li', 'is-empty', 'Nobody has joined yet. Be the first.')]));

    if (!me) return;
    const mine = lobby.players.find((p) => p.id === me.id);
    const others = lobby.players.filter((p) => p.id !== me.id);

    const rows = lobby.players.map((p) => {
      const row = el('li');
      const name = el('span', 'name', p.name);
      if (p.id === me.id) name.append(el('span', 'you', 'you'));
      const badge = el('span', 'badge', p.status === 'lobby' && p.ready ? 'Ready' : STATUS[p.status] || p.status);
      badge.dataset.kind = p.status === 'lobby' && p.ready ? 'ready' : p.status;
      row.append(name, el('span', 'wins', `${p.wins} ${p.wins === 1 ? 'win' : 'wins'}`), badge);
      return row;
    });
    const waiting = lobby.online - lobby.players.length;
    if (waiting > 0) rows.push(el('li', 'is-empty', `${waiting} more ${waiting === 1 ? 'client is' : 'clients are'} choosing a nickname…`));
    $('lobby-list').replaceChildren(...rows);

    for (const button of document.querySelectorAll('.mode')) button.setAttribute('aria-checked', String(button.dataset.mode === lobby.mode));
    if (document.activeElement !== themeInput) themeInput.value = lobby.theme || ''; // don't overwrite while someone types

    const ready = Boolean(mine && mine.ready);
    const readyBtn = $('ready-btn');
    readyBtn.textContent = ready ? 'Ready. Tap to cancel' : "I'm ready";
    readyBtn.classList.toggle('is-on', ready);

    let status;
    if (lobby.match) status = `${lobby.match.players.join(' vs ')} are playing right now. Ready up to go next.`;
    else if (!others.length) status = 'You are the only player here. A match needs two.';
    else if (ready) status = 'Waiting for one more player to ready up…';
    else if (others.some((p) => p.status === 'lobby' && p.ready)) status = `${others.find((p) => p.ready).name} is ready and waiting for you.`;
    else status = `${others.length} other ${others.length === 1 ? 'player is' : 'players are'} online. Ready up to start.`;
    $('lobby-status').textContent = status;
  }

  /* ── Match: setup ──────────────────────────────────────────────────────── */

  function onPreparing(data) {
    leaveGame();
    const foe = data.players.find((p) => p.id !== me.id);
    game = {
      id: data.matchId,
      mode: data.mode,
      phase: 'preparing',
      foe,
      stats: null,
      combo: [],
      level: 0,
      weatherLabel: '',
      durationMs: 60000,
      endAt: 0,
      shownSecs: -1,
      shownArrows: null,
      countdown: null,
    };
    $('me-name').textContent = me.name;
    $('foe-name').textContent = foe.name;
    $('booth-text').textContent = 'The commentator is warming up…';
    $('booth-tag').textContent = 'Booth';
    $('booth').dataset.source = '';
    $('voice-btn').hidden = !data.voice;
    $('tag-words').textContent = '';
    $('tag-level').textContent = '';
    $('tag-weather').textContent = '';
    setStats({ [me.id]: blankStats(), [foe.id]: blankStats() });

    $('prep-welcome').textContent = `Welcome, ${me.name}.`;
    $('vs-me').textContent = me.name;
    $('vs-foe').textContent = foe.name;
    const count = $('prep-count');
    count.className = 'prep__count is-wait';
    count.textContent = data.ai
      ? `AI is writing "${data.theme}" words…`
      : data.themeAi
        ? `AI is picking "${data.theme}" words…`
        : 'Shuffling the word set…';
    $('prep-note').textContent = data.mode === 'storm' ? 'Storm mode: combos, wind and adaptive speed' : 'Classic mode: one point per word';
    $('overlay-prep').hidden = false;
    $('overlay-end').hidden = true;
    replay($('overlay-prep'), 'is-vs'); // the names slide in and the bolt strikes
    show('game');
    measureField();
    sound('whoosh');
    setTimeout(() => sound('zap'), 380);
  }

  const blankStats = () => ({ score: 0, streak: 0, mult: 1, best: 0, hits: 0, misses: 0, accuracy: null });

  function onMatchStart(data) {
    if (!game || game.id !== data.matchId) return;
    game.phase = 'countdown';
    game.combo = data.combo;
    game.durationMs = data.durationMs;
    game.level = data.level;
    game.weatherLabel = data.weather.label;
    sky.wind = data.weather.wind;
    sky.rain = data.weather.rain;
    setStats(data.stats);
    $('tag-words').textContent = `${data.source === 'bank' ? 'Word bank' : 'AI words'} · ${data.theme}`;
    renderLevel();
    renderWeather(true);
    $('prep-note').textContent = `${data.source === 'bank' ? 'Word bank' : 'AI word set'} · theme: ${data.theme}`;

    const until = performance.now() + data.countdownMs;
    const count = $('prep-count');
    count.className = 'prep__count';
    let shown = null;
    const step = () => {
      const n = Math.ceil((until - performance.now()) / 1000);
      const text = n > 0 ? String(n) : 'GO';
      if (text !== shown) {
        shown = text;
        count.textContent = text;
        replay(count, 'is-tick');
        sound(text === 'GO' ? 'go' : 'beep');
      }
    };
    step();
    game.countdown = setInterval(step, 50);
  }

  function onGo(data) {
    if (!game) return;
    clearInterval(game.countdown);
    game.phase = 'playing';
    game.endAt = performance.now() + data.durationMs;
    $('overlay-prep').hidden = true;
    typeEl.disabled = false;
    typeEl.value = '';
    typeEl.focus();
    refreshTyping();
  }

  function leaveGame() {
    stopVoice();
    if (game) clearInterval(game.countdown);
    game = null;
    for (const word of words.values()) word.el.remove();
    words.clear();
    $('words').replaceChildren();
    $('overlay-prep').hidden = true;
    $('overlay-end').hidden = true;
    typeEl.value = '';
    typeEl.disabled = true;
    refreshTyping();
    sky.wind = 0.12;
    sky.rain = 0.35;
  }

  /* ── Match: live state ─────────────────────────────────────────────────── */

  function measureField() {
    field.w = field.el.clientWidth;
    field.h = field.el.clientHeight;
    sizeFx();
    drawFieldCity();
  }
  new ResizeObserver(measureField).observe(field.el);

  function addWord(data) {
    if (!game) return;
    const node = el('div', `word tier-${data.tier}`);
    const letters = [...data.text].map((ch) => node.appendChild(el('span', '', ch)));
    $('words').append(node);
    words.set(data.id, {
      id: data.id,
      text: data.text,
      el: node,
      letters,
      pw: node.offsetWidth,
      ph: node.offsetHeight,
      // last server sample, and where we are drawing the word right now
      sx: data.x, sy: data.y, vx: 0, vy: 0, at: performance.now(),
      x: data.x, y: data.y, tilt: 0, px: 0, py: 0,
    });
    refreshTyping();
  }

  function onState(data) {
    if (!game || game.phase !== 'playing') return;
    const now = performance.now();
    const endAt = now + data.t;
    if (Math.abs(endAt - game.endAt) > 120) game.endAt = endAt; // follow the server's clock, ignore jitter
    for (const [id, x, y, vx, vy] of data.w) {
      const word = words.get(id);
      if (!word) continue;
      word.sx = x;
      word.sy = y;
      word.vx = vx;
      word.vy = vy;
      word.at = now;
    }
    sky.wind = data.wind;
    sky.rain = data.rain;
    renderWeather(false);
  }

  function removeWord(id) {
    const word = words.get(id);
    if (!word) return null;
    word.el.remove(); // gone at once, on both screens
    words.delete(id);
    refreshTyping();
    return word;
  }

  function effect(className, x, y, text) {
    const node = el('div', className, text);
    node.style.setProperty('--x', `${Math.round(x)}px`);
    node.style.setProperty('--y', `${Math.round(y)}px`);
    $('words').append(node);
    setTimeout(() => node.remove(), 750);
  }

  function onClaimed(data) {
    if (!game) return;
    const word = removeWord(data.id);
    const mine = data.by === me.id;
    if (word) {
      effect(`pop ${mine ? 'pop--me' : 'pop--foe'}`, word.px + word.pw / 2 - 12, word.py, `+${data.points}`);
      burst(word.px + word.pw / 2, word.py + word.ph / 2, mine ? '#22e3ff' : '#ff3df2');
    }
    sound(mine ? 'score' : 'rival');
    setStats(data.stats);
  }

  function onGone(data) {
    const word = removeWord(data.id);
    if (!word) return;
    splash(word.px + word.pw / 2);
    sound('splash');
  }

  function onWeather(data) {
    if (!game) return;
    game.weatherLabel = data.label;
    game.weatherKey = data.key;
    renderWeather(true);
    const push = Math.abs(data.wind) < 0.1 ? 'the air goes still' : `wind pushes words ${data.wind > 0 ? 'right' : 'left'}`;
    banner(`${data.label}: ${push}`, 'weather');
    if (data.key === 'gale') lightning();
  }

  function onDifficulty(data) {
    if (!game) return;
    game.level = data.level;
    renderLevel(data.dir);
    banner(data.dir === 'up' ? `Speeding up (${data.why})` : `Easing off (${data.why})`, data.dir);
  }

  function onCommentary(data) {
    if (!game) return;
    $('booth-text').textContent = data.text;
    $('booth-tag').textContent = data.source === 'ai' ? 'AI booth' : 'Booth';
    $('booth').dataset.source = data.source;
    replay($('booth'), 'is-fresh');
    if (data.audio) playVoice(data.audio);
    if (game.phase === 'ended') $('end-quote').textContent = `"${data.text}"`;
  }

  /* ── Match: HUD ────────────────────────────────────────────────────────── */

  /** Scores count up to their new value instead of jumping; a reset to zero jumps straight there. */
  function setScore(node, value) {
    const from = Number(node.dataset.value || 0);
    if (from === value && node.textContent === String(value)) return;
    node.dataset.value = value;
    replay(node, 'is-bump');
    if (reducedMotion || value <= from) {
      node.textContent = value;
      return;
    }
    const start = performance.now();
    const step = (now) => {
      if (Number(node.dataset.value) !== value) return; // a newer score took over
      const t = Math.min(1, (now - start) / 400);
      node.textContent = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const streakText = (s) => (s.streak >= 2 ? `${s.streak} in a row${s.mult > 1 ? ` · ×${s.mult}` : ''}` : '');

  function setStats(stats) {
    if (!game) return;
    const before = game.stats && game.stats[me.id];
    game.stats = stats;
    const mine = stats[me.id];
    const theirs = stats[game.foe.id];
    const milestone = game.mode === 'storm' ? before && mine.mult > before.mult : [5, 10].includes(mine.streak);
    if (before && mine.streak > before.streak && milestone) {
      sound('combo');
      if (!reducedMotion) replay(field.el, 'is-shake');
    }
    setScore($('me-score'), mine.score);
    setScore($('foe-score'), theirs.score);
    $('me-meta').textContent = streakText(mine);
    $('foe-meta').textContent = streakText(theirs);
    $('acc').textContent = mine.accuracy === null ? '–' : `${mine.accuracy}%`;

    // Combo meter: progress toward the next multiplier
    const steps = game.combo;
    const next = steps.find(([need]) => need > mine.streak);
    const floor = [...steps].reverse().find(([need]) => need <= mine.streak);
    $('combo').dataset.mult = mine.mult;
    $('combo-mult').textContent = `×${mine.mult}`;
    let label;
    let fill;
    if (game.mode !== 'storm') {
      label = mine.streak >= 2 ? `${mine.streak} in a row` : 'Classic: 1 point per word';
      fill = Math.min(1, mine.streak / 10);
    } else if (!steps.length) {
      label = 'Combo'; // the multiplier steps arrive with matchStart
      fill = 0;
    } else if (next) {
      const from = floor ? floor[0] : 0;
      label = `${mine.streak} in a row · ${next[0] - mine.streak} more for ×${next[1]}`;
      fill = (mine.streak - from) / (next[0] - from);
    } else {
      label = `${mine.streak} in a row · top multiplier`;
      fill = 1;
    }
    $('combo-label').textContent = label;
    $('combo-fill').style.width = `${Math.round(fill * 100)}%`;

    // Tug of war: the knot slides toward whoever leads (you pull left, your opponent pulls right)
    const diff = mine.score - theirs.score;
    const pull = Math.tanh(diff / 7) * 46; // % of the rope, easing off as the gap grows
    $('tug').dataset.lead = diff > 0 ? 'me' : diff < 0 ? 'foe' : 'even';
    $('tug-knot').style.left = `${50 - pull}%`;
    $('tug-fill').style.left = `${Math.min(50, 50 - pull)}%`;
    $('tug-fill').style.width = `${Math.abs(pull)}%`;
    $('tug-label').textContent = diff === 0 ? 'Even' : `${diff > 0 ? 'You' : game.foe.name} +${Math.abs(diff)}`;
  }

  function renderLevel(dir) {
    const tag = $('tag-level');
    tag.textContent = game.mode === 'storm' ? `Speed ${game.level}/5` : 'Steady speed';
    tag.classList.toggle('is-up', dir === 'up');
    tag.classList.toggle('is-down', dir === 'down');
    if (dir) setTimeout(() => tag.classList.remove('is-up', 'is-down'), 2500);
  }

  function renderWeather(force) {
    const strength = Math.abs(sky.wind);
    const count = strength < 0.08 ? 0 : strength < 0.35 ? 1 : strength < 0.7 ? 2 : 3;
    const arrows = (sky.wind > 0 ? '→' : '←').repeat(count);
    if (!force && arrows === game.shownArrows) return;
    game.shownArrows = arrows;
    $('tag-weather').textContent = `${game.weatherLabel}${arrows ? ` ${arrows}` : ''}`;
  }

  function renderTimer(now) {
    const left = game.phase === 'playing' ? Math.max(0, game.endAt - now) : game.phase === 'ended' ? 0 : game.durationMs;
    const secs = Math.ceil(left / 1000);
    if (secs === game.shownSecs) return;
    game.shownSecs = secs;
    const timer = $('timer');
    timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    timer.classList.toggle('is-urgent', game.phase === 'playing' && secs <= 10);
    if (game.phase === 'playing' && secs > 0 && secs <= 5) sound('tick');
  }

  /* ── Typing ────────────────────────────────────────────────────────────── */

  function sharedPrefix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  let typedBefore = 0; // length of the box at the last refresh, to tell a new letter from a backspace

  /** Colours what the player has typed: green where it matches a falling word, red where it stops matching. */
  function refreshTyping() {
    const typed = typeEl.value.toLowerCase();
    let target = null;
    let reach = 0; // longest prefix of `typed` that matches some falling word
    let onTrack = false; // typed is the start of at least one word
    let exact = false; // typed is a whole word: ready to submit

    for (const word of words.values()) {
      word.match = sharedPrefix(typed, word.text);
      if (typed && word.match === typed.length) {
        onTrack = true;
        if (word.text.length === typed.length) exact = true;
      }
      // aim at the closest match; between equals, the one nearest the ground
      if (word.match > reach || (word.match === reach && reach > 0 && word.y > target.y)) {
        target = word;
        reach = word.match;
      }
    }

    for (const word of words.values()) {
      const fits = typed.length > 0 && word.match === typed.length;
      const nearMiss = !onTrack && word === target && reach > 0;
      word.letters.forEach((letter, i) => {
        let cls = '';
        if (fits && i < typed.length) cls = 'ok';
        else if (nearMiss) cls = i < reach ? 'ok' : i < typed.length ? 'bad' : '';
        if (letter.className !== cls) letter.className = cls;
      });
      word.el.classList.toggle('is-target', fits || nearMiss);
      word.el.classList.toggle('is-exact', fits && word.text.length === typed.length);
    }

    // a new letter that matches no falling word gets a low thunk, on top of the key tick
    if (typed.length > typedBefore && !onTrack) sound('typo');
    typedBefore = typed.length;

    $('echo').replaceChildren(...[...typed].map((ch, i) => el('span', i < reach ? 'ok' : 'bad', ch)));
    dock.dataset.state = !typed ? 'idle' : exact ? 'exact' : onTrack ? 'ok' : 'bad';
  }

  /** Sends one word to the server. `rest` is whatever should stay in the box afterwards. */
  function submit(word = typeEl.value, rest = '') {
    const text = word.trim().toLowerCase();
    typeEl.value = rest;
    refreshTyping();
    if (!text || !game || game.phase !== 'playing') return;
    socket.emit('submit', text, (res) => {
      if (res.result === 'hit') {
        replay(dock, 'is-hit');
        note(res.points > 1 ? `+${res.points} combo!` : '+1');
      } else if (res.result === 'miss') {
        replay(dock, 'is-miss');
        sound('miss');
        note(res.lost >= 2 ? `"${text}" is not falling. Streak of ${res.lost} lost` : `"${text}" is not falling`);
      } else if (res.result === 'late') {
        note(res.by ? `Too slow: ${res.by} got "${text}"` : `Too late for "${text}"`);
      }
    });
  }

  const lettersOnly = (text) => text.replace(/[^a-zA-Z]/g, '');

  typeEl.addEventListener('input', () => {
    const raw = typeEl.value;
    const space = raw.search(/\s/); // phones (and pastes) deliver the space here instead of in keydown
    if (space === -1) {
      typeEl.value = lettersOnly(raw);
      refreshTyping();
    } else {
      submit(lettersOnly(raw.slice(0, space)), lettersOnly(raw.slice(space))); // one word per submit; the rest stays typed
    }
  });

  typeEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      submit();
    } else if (event.key.length === 1 || event.key === 'Backspace') {
      sound('key');
    }
  });

  // Keep the keyboard on the input for the whole match
  document.addEventListener('keydown', (event) => {
    if (game && game.phase === 'playing' && document.activeElement !== typeEl && event.key.length === 1 && !event.metaKey && !event.ctrlKey) typeEl.focus();
  });
  field.el.addEventListener('pointerdown', () => game && game.phase === 'playing' && setTimeout(() => typeEl.focus(), 0));

  /* ── Match: results and rematch ────────────────────────────────────────── */

  function onMatchEnd(data) {
    if (!game) return;
    game.phase = 'ended';
    game.shownSecs = -1; // redraw the clock as a calm 0:00
    typeEl.disabled = true;
    typeEl.value = '';
    for (const id of [...words.keys()]) removeWord(id);

    const mine = data.players.find((p) => p.id === me.id);
    const theirs = data.players.find((p) => p.id !== me.id);
    const percent = (p) => (p.accuracy === null ? '–' : `${p.accuracy}%`);
    $('result').dataset.result = data.result;
    $('end-kicker').textContent = data.note || "Time's up";
    $('end-verdict').textContent = data.result; // "Win", "Lost" or "Draw"
    sound(data.result === 'Win' ? 'win' : data.result === 'Lost' ? 'lost' : 'beep');
    $('end-me-name').textContent = mine.name;
    $('end-me-score').textContent = mine.score;
    $('end-foe-name').textContent = theirs.name;
    $('end-foe-score').textContent = theirs.score;
    const rows = [
      [percent(mine), 'Accuracy', percent(theirs)],
      [mine.best, 'Best streak', theirs.best],
      [mine.hits, 'Words typed', theirs.hits],
      [mine.misses, 'Typos', theirs.misses],
    ];
    $('end-stats').replaceChildren(
      ...rows.map((cells) => {
        const row = el('tr');
        row.append(...cells.map((cell) => el('td', '', String(cell))));
        return row;
      }),
    );
    $('end-quote').textContent = '';

    const rematch = $('rematch-btn');
    rematch.disabled = !data.canRematch;
    rematch.textContent = 'Rematch';
    rematch.classList.remove('is-nudge');
    $('rematch-status').textContent = data.canRematch ? 'A rematch starts when both players agree.' : 'Your opponent left, so there is no rematch. Head back to the lobby.';
    $('overlay-end').hidden = false;
    rematch.focus();
  }

  function onRematchStatus(data) {
    if (!game || game.phase !== 'ended') return;
    const mine = data.agreed.includes(me.id);
    const theirs = data.agreed.includes(game.foe.id);
    const rematch = $('rematch-btn');
    if (mine) {
      rematch.disabled = true;
      rematch.textContent = 'Rematch requested';
      rematch.classList.remove('is-nudge');
      $('rematch-status').textContent = theirs ? 'Both agreed. Starting…' : `Waiting for ${game.foe.name} to agree…`;
    } else if (theirs) {
      rematch.classList.add('is-nudge');
      $('rematch-status').textContent = `${game.foe.name} wants a rematch!`;
    }
  }

  function onOpponentLeft(data) {
    if (!game || game.phase !== 'ended') return;
    const rematch = $('rematch-btn');
    rematch.disabled = true;
    rematch.classList.remove('is-nudge');
    rematch.textContent = 'Rematch';
    $('rematch-status').textContent = `${data.name} left, so there is no rematch. Head back to the lobby.`;
  }

  $('rematch-btn').addEventListener('click', () => socket.emit('rematch'));
  $('lobby-btn').addEventListener('click', () => {
    socket.emit('leaveMatch');
    backToLobby();
  });

  /* ── Lobby controls ────────────────────────────────────────────────────── */

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('nick').value.trim();
    if (name && socket && socket.connected) join(name);
  });

  $('ready-btn').addEventListener('click', () => {
    const mine = lobby.players.find((p) => p.id === me.id);
    socket.emit('ready', !(mine && mine.ready));
  });

  for (const button of document.querySelectorAll('.mode')) button.addEventListener('click', () => socket.emit('setMode', button.dataset.mode));

  const themeInput = $('theme-input');
  themeInput.addEventListener('change', () => socket.emit('setTheme', themeInput.value));
  themeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') themeInput.blur(); // blurring fires 'change'
  });

  /* ── Rain ──────────────────────────────────────────────────────────────── */

  const rainCanvas = $('rain');
  const ctx = rainCanvas.getContext('2d');
  const drops = [];
  let viewW = 0;
  let viewH = 0;

  function resizeRain() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    rainCanvas.width = viewW * dpr;
    rainCanvas.height = viewH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeRain);
  resizeRain();

  function resetDrop(drop, anywhere) {
    drop.depth = 0.35 + Math.random() * 0.65;
    drop.x = Math.random() * (viewW + 600) - 300; // wide enough that slanted rain still covers the corners
    drop.y = anywhere ? Math.random() * viewH : -30;
    drop.len = 9 + drop.depth * 17;
    drop.speed = 480 + drop.depth * 560;
    return drop;
  }

  // The rain follows the server's weather: more wind → more slant, more rain → more and faster drops.
  function drawRain(dt) {
    sky.shownWind += (sky.wind - sky.shownWind) * Math.min(1, dt * 3);
    sky.shownRain += (sky.rain - sky.shownRain) * Math.min(1, dt * 2);
    const area = Math.min(1.6, (viewW * viewH) / 9e5);
    const want = Math.round((reducedMotion ? 0.25 : 1) * (30 + sky.shownRain * 250) * area);
    while (drops.length < want) drops.push(resetDrop({}, true));
    if (drops.length > want) drops.length = want;

    const slant = sky.shownWind * 0.6; // sideways travel per unit of fall
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.lineCap = 'round';
    for (const drop of drops) {
      const fall = drop.speed * (0.7 + sky.shownRain * 0.6) * dt;
      drop.y += fall;
      drop.x += fall * slant;
      if (drop.y - drop.len > viewH) resetDrop(drop, false);
      ctx.strokeStyle = `rgba(170, 205, 255, ${0.08 + drop.depth * 0.26})`;
      ctx.lineWidth = drop.depth * 1.5;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x - drop.len * slant, drop.y - drop.len);
      ctx.stroke();
    }
  }

  /* ── Frame loop ────────────────────────────────────────────────────────── */

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (game) {
      renderTimer(now);
      const ease = Math.min(1, dt * 16);
      for (const word of words.values()) {
        // extrapolate a little from the last server sample, then ease toward it so motion stays smooth at 60 fps
        const age = Math.min(0.12, (now - word.at) / 1000);
        word.x += (word.sx + word.vx * age - word.x) * ease;
        word.y += (word.sy + word.vy * age - word.y) * ease;
        word.tilt += (clamp(word.vx * 70, -8, 8) - word.tilt) * Math.min(1, dt * 6);
        word.px = clamp(word.x * field.w, word.pw / 2 + 4, field.w - word.pw / 2 - 4) - word.pw / 2;
        word.py = word.y * (field.h - GROUND) - word.ph;
        const tilt = reducedMotion ? 0 : word.tilt;
        word.el.style.transform = `translate3d(${word.px.toFixed(1)}px, ${word.py.toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
      }
    }

    drawRain(dt);
    drawFx(dt);
    updateAmbience(now);
    if (game && game.phase === 'playing' && game.weatherKey === 'gale' && Math.random() < dt * 0.22) lightning(); // a gale keeps flashing
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  boot();
})();
