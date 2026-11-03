'use strict';

// npm run check:ai   makes one real word request and one real commentary request, so a bad key
// or a blocked network shows up here instead of in the middle of the demo.

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* no .env: llm.js reports that below */
}
const llm = require('../llm');

async function main() {
  if (!llm.enabled()) {
    console.error(`AI is off: ${llm.status().reason}. Paste your key after ANTHROPIC_API_KEY= in .env and try again.`);
    process.exit(1);
  }
  console.log(`Asking ${llm.status().model} for words…`);
  const words = await llm.generateWords({ theme: 'ocean', counts: { easy: 5, medium: 5, hard: 5 } });
  console.log(`  easy:   ${words.easy.join(', ')}\n  medium: ${words.medium.join(', ')}\n  hard:   ${words.hard.join(', ')}`);

  console.log('Asking for one commentary line…');
  const line = await llm.commentate({
    scoreline: 'Alice 7 (streak 3) vs Bob 6 (streak 0). 12s left. Weather: Gale. Difficulty 3/5.',
    events: ['Alice overtakes Bob for the lead'],
  });
  console.log(`  "${line}"`);

  const { inputTokens, outputTokens } = llm.status();
  console.log(`OK: the key works. Used ${inputTokens} input and ${outputTokens} output tokens.`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
