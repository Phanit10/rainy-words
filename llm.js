'use strict';

/**
 * LLM gateway — every model call the game makes goes through this file.
 *
 * Plug in a key: copy .env.example to .env and set ANTHROPIC_API_KEY.
 * Without a key the game still runs — words come from wordbank.js and the
 * commentator uses the canned lines at the bottom of this file.
 *
 * Token budget: one bulk request per match for the whole word set, and one short
 * request per batch of major events for commentary (server.js rate-limits those).
 * To use another provider, replace ask() — nothing else in the game talks to a model.
 */

const MODEL = process.env.LLM_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.LLM_EFFORT || 'low'; // short creative replies: keep them fast and cheap
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Optional request features that not every model accepts.
const TAKES_EFFORT = !MODEL.includes('haiku');
const TAKES_FALLBACKS = /^claude-(fable-5-1|opus-5|sonnet-5-5)/.test(MODEL);

let Anthropic = null;
let client = null;
let disabledReason = HAS_KEY ? null : 'no ANTHROPIC_API_KEY in .env';
let rich = true; // send the optional features until the API rejects them once

const usage = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, words: 0, commentary: 0, lastError: null };

function getClient() {
  if (!client) {
    const sdk = require('@anthropic-ai/sdk');
    Anthropic = sdk.default || sdk;
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  }
  return client;
}

function explain(err) {
  if (!Anthropic) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'API key rejected (401)';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key has no access to this model (403)';
  if (err instanceof Anthropic.NotFoundError) return `model "${MODEL}" not found (404)`;
  if (err instanceof Anthropic.RateLimitError) return 'rate limited (429)';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'network error';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err.message;
}

/** One request, one text reply. Throws on any failure so callers can fall back. */
async function ask({ kind, system, user, maxTokens, schema, timeoutMs }) {
  if (disabledReason) throw new Error(disabledReason);
  const api = getClient();
  const base = { model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  const options = { timeout: timeoutMs, maxRetries: 0 }; // a late answer is useless mid-match
  usage.calls += 1;
  usage[kind] += 1;

  try {
    let res = null;
    if (rich) {
      const output_config = {};
      if (TAKES_EFFORT) output_config.effort = EFFORT;
      if (schema) output_config.format = { type: 'json_schema', schema };
      const body = Object.keys(output_config).length ? { ...base, output_config } : base;
      try {
        res = TAKES_FALLBACKS
          ? // if a safety classifier declines, the API re-runs the request on its recommended fallback model
            await api.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, options)
          : await api.messages.create(body, options);
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError)) throw err;
        rich = false;
        console.warn(`[ai] ${MODEL} rejected an optional request feature (${err.message}); using plain requests from now on`);
      }
    }
    if (!res) res = await api.messages.create(base, options);

    usage.inputTokens += res.usage?.input_tokens ?? 0;
    usage.outputTokens += res.usage?.output_tokens ?? 0;
    if (res.stop_reason === 'refusal') throw new Error('the model declined the request');
    const text = res.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
    if (!text) throw new Error(`empty reply (stop_reason: ${res.stop_reason})`);
    return text;
  } catch (err) {
    usage.failures += 1;
    usage.lastError = explain(err);
    const badKey = Anthropic && (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError);
    if (badKey) disabledReason = usage.lastError; // stop retrying a key that cannot work
    throw new Error(usage.lastError);
  }
}

/* ── Feature 1: the word set, fetched in bulk once per match ─────────────── */

const stringList = { type: 'array', items: { type: 'string' } };
const WORD_SCHEMA = {
  type: 'object',
  properties: { easy: stringList, medium: stringList, hard: stringList },
  required: ['easy', 'medium', 'hard'],
  additionalProperties: false,
};

async function generateWords({ theme, counts }) {
  const text = await ask({
    kind: 'words',
    system: 'You write word lists for a typing game. Reply with JSON only.',
    user:
      `Theme: ${theme}. Return {"easy":[${counts.easy} words of 3-4 letters],` +
      `"medium":[${counts.medium} words of 5-6 letters],"hard":[${counts.hard} words of 7-10 letters]}. ` +
      'Common English words tied to the theme, lowercase a-z only, single words, no proper nouns, no repeats, nothing offensive.',
    maxTokens: 4000,
    schema: WORD_SCHEMA,
    timeoutMs: 12_000,
  });
  const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  return { easy: strings(data.easy), medium: strings(data.medium), hard: strings(data.hard) };
}

/* ── Feature 2: the commentator, one line per batch of major events ──────── */

const COMMENTATOR =
  'You are the live commentator for Rainy Words, a 60-second two-player typing race where words fall like rain. ' +
  'Write ONE play-by-play line, at most 16 words, plain text, no quotes or hashtags. Call players by name. ' +
  'Adapt your tone to the match: tense when scores are close, electric for combos and comebacks, ' +
  'playfully kind to whoever trails, urgent in the final seconds.';

async function commentate({ scoreline, events }) {
  const text = await ask({
    kind: 'commentary',
    system: COMMENTATOR,
    user: `${scoreline}\nJust happened: ${events.join('; ')}.`,
    maxTokens: 1000,
    timeoutMs: 6_000,
  });
  return text.split('\n')[0].replace(/^["'“”\s]+|["'“”\s]+$/g, '').slice(0, 160);
}

/* ── Offline commentator ─────────────────────────────────────────────────── */

const LOCAL_LINES = {
  first_lead: [(e) => `${e.who} strikes first, and the storm has a leader!`, (e) => `First blood to ${e.who}!`],
  lead_change: [
    (e) => `${e.who} snatches the lead from ${e.other}!`,
    (e) => `Lead change! ${e.who} surges past ${e.other}.`,
    (e) => `${e.other} blinks and ${e.who} is in front!`,
  ],
  combo: [
    (e) => `${e.who} is on fire: ${e.n} in a row!`,
    (e) => `${e.n}-word combo for ${e.who}. Somebody stop them!`,
    (e) => `${e.who} can't miss, that's ${e.n} straight!`,
  ],
  combo_break: [(e) => `Ouch! ${e.who}'s ${e.n}-word streak washes away.`, (e) => `A typo ends ${e.who}'s run at ${e.n}.`],
  final_stretch: [() => 'Ten seconds left, every word counts now!', () => 'Final ten seconds. Fingers, do not fail!'],
  match_end: [
    (e) => (e.winner ? `${e.winner} takes it ${e.score}. What a downpour!` : `All square at ${e.score}, and nobody blinks.`),
    (e) => (e.winner ? `Game over! ${e.winner} wins ${e.score}.` : `A ${e.score} draw. Run it back?`),
  ],
};

function localLine(event) {
  const options = LOCAL_LINES[event.type] || [() => 'The rain keeps falling…'];
  return options[Math.floor(Math.random() * options.length)](event);
}

module.exports = {
  enabled: () => !disabledReason,
  status: () => ({ enabled: !disabledReason, reason: disabledReason, model: MODEL, ...usage }),
  generateWords,
  commentate,
  localLine,
};
