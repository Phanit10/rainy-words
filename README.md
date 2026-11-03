# Rainy Words

A two-player typing race built on socket programming. Words fall like rain on both players' screens; whoever types a word first scores, and the word disappears for both. A match lasts exactly 60 seconds.

One Node.js server owns all game state and talks to the players' browsers over Socket.IO. The server computer also runs a game client; the second computer only needs a browser.

## Run it

Needs [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm run set-host   # writes this computer's network address into public/config.js
npm start
```

On macOS you can double-click `start.command` instead: it updates the address and starts the server in one go.

The first start downloads the two on-device AI models (about 120 MB) into `models/`. After that the game works without internet.

- **Server computer:** open `http://localhost:3210` to play, and `http://localhost:3210/admin` for the server console (connected clients, the current word set, and the Reset button). The console only opens on the server computer.
- **Second computer:** open the address the server prints at startup, e.g. `http://192.168.1.37:3210`. Alternatively, copy the `public/` folder across and double-click `index.html` (Chrome), so no address is typed.

Both computers must be on the same network; a phone hotspot is the easiest. When the network changes, run `npm run set-host` again and restart the server (and re-copy `public/` if you use that method).

## How to play

Enter a nickname, pick a mode, optionally type a theme, and click **I'm ready**. The match starts when two players are ready. Type the falling words and press Enter or Space. At the end you see Win or Lost, both scores, and a Rematch button.

- **Classic:** the assignment's rules: one point per word, steady speed.
- **Storm:** combo multipliers, wind and rain that push the words around, and speed that adapts to the players' accuracy.

## Features

- **AI theme words:** a small embedding model (all-MiniLM-L6-v2) running on the server picks the words that best fit each match's theme, from a built-in pool of about 1,300 words.
- **AI commentator voice:** Kokoro-82M, a text-to-speech model running on the server, speaks every commentary line.
- **Optional Claude features:** with an API key, Claude writes the word lists and the play-by-play commentary (see below).
- Combo multipliers, wind and rain physics, adaptive difficulty, a tug-of-war score bar, live green/red typing feedback, a neon city look, and sound effects generated in the browser.

## Optional: Claude API key

Copy `.env.example` to `.env` and paste your key after `ANTHROPIC_API_KEY=`, then restart. Check it with `npm run check:ai`. Without a key, the local AI picks the words and the commentator uses built-in lines (still spoken by Kokoro).

Other settings in `.env`: `VOICE=off`, `VOICE_NAME=am_michael`, `THEME_AI=off`, `LLM_MODEL=...`.

## Tests

```bash
npm test
```

Runs the game rules, the LLM path (against a local mock, so no key or cost), the theme model and the voice, with real socket clients against the real server. It takes about 4 minutes and needs port 3210 free, so stop the server first.

To rehearse alone, run a practice opponent: `npm run bot -- Bob 2600 rematch`.

## Project layout

| Path | What it is |
| --- | --- |
| `server.js` | The game server: lobby, matches, scoring, weather, difficulty, commentary, server console |
| `public/` | The browser client (`index.html`, `style.css`, `client.js`) and `config.js` with the server address |
| `admin/` | The server console page |
| `llm.js` | Claude word lists and commentary, with offline fallbacks |
| `theme-words.js`, `voice.js` | The two on-device AI models, run in one worker (`models.js`, `models-worker.js`) |
| `wordpool.js`, `wordbank.js` | The word pool for theme words, and the fallback word bank |
| `scripts/` | `set-host` and `check:ai` |
| `test/` | The test suite and the practice bot |

The Orbitron font is used under the SIL Open Font License (`public/fonts/OFL.txt`).
