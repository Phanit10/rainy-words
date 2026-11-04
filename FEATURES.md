# Rainy Words: extra features

For the extra-features table in the score criteria (AI feature: 2 points, non-AI feature: 1 point).
Each row says how to show the feature during the demo.

| # | Feature name | AI | What it does | How to show it |
|---|---|:---:|---|---|
| 1 | AI theme words | ✓ | A small embedding model (all-MiniLM-L6-v2) runs on the server and picks the ~1,300-word pool's best fits for a theme the players type. | Type a theme such as "ocean" in the lobby; the falling words and the server console's word set match it. |
| 2 | AI commentator voice | ✓ | Kokoro-82M, a text-to-speech model running on the server, speaks a live commentary line during the match. | Play a match with Sound and Voice on; the commentator reacts to scores and combos. |
| 3 | Storm mode with combo multipliers | | A separate mode: from the 3rd, 6th and 10th word of a streak, each word scores 2, 3 or 4 points; a typo ends the streak. Classic keeps the 1-point rule. | Pick Storm in the lobby; type 3 words in a row and the third scores +2. |
| 4 | Wind and rain physics | | In Storm, weather fronts blow the words sideways and the rain grows heavier. | Watch the words drift during a Storm match. |
| 5 | Adaptive difficulty | | In Storm, the falling speed rises or falls with the players' accuracy. | Type accurately and the words speed up; the server terminal logs each change. |
| 6 | Tug-of-war score bar | | A bar between the two scores shifts toward whoever is ahead. | Score a few words; the bar moves to your side. |
| 7 | Live typing feedback | | Letters turn green while they match a falling word and red where they stop matching; the target word is highlighted. | Type part of a word, then a wrong letter. |
| 8 | Generated sound effects | | Every sound (rain, scoring, typos, button clicks, countdown, win/lose) is synthesised in the browser, with no audio files. | Play with Sound on; type a wrong letter or click a button. |

Optional third AI feature: with an Anthropic API key in `.env`, Claude writes each match's word list and the play-by-play commentary (`npm run check:ai` confirms the key works).

## Fundamental requirements, for the walkthrough

| Requirement | Where |
|---|---|
| Socket programming, client-server | Socket.IO between `public/client.js` and `server.js` |
| Server address and port in the source code | `public/config.js` (written by `npm run set-host` / `start.bat`) |
| Clients see the other connected clients | "Online now" list in the lobby |
| Nickname and "Welcome, Alice." | Join screen, then the lobby and match screens |
| Name, score, text input, 1-minute countdown | Match screen |
| First correct typist gets 1 point; the word disappears for both | Classic mode (the default) |
| Win / Lost, both scores, Rematch | Results screen |
| New unique word set on every match and rematch | Server console and terminal log |
| Server shows client count, client list, word set | `http://localhost:3210/admin` and the terminal |
| Server Reset button | Server console, "Reset game and scores" |
