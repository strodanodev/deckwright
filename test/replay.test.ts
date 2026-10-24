import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { endTurn } from '../src/core/actions';
import { greedyBot } from '../src/core/bot';
import { normalizeStats } from '../src/core/champion';
import { compileGame } from '../src/core/game';
import { createRules } from '../src/core/rules';
import type { GameConfig, MatchState } from '../src/core/types';
import { checkRecord, decodeRecord, encodeRecord, recordOf, replayStates } from '../src/client/replay';
import { LocalBotSession, ReplaySession } from '../src/client/session';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const load = (p: string): GameConfig => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as GameConfig;
const SAMPLE = load('test/fixtures/sample-duel.game.json');
const STARTER_PATH = join(ROOT, 'templates', 'starter.game.json');
const STARTER = load('templates/starter.game.json');

/** Bot vs bot to the end, logged the way a session logs it. */
function botMatch(game: GameConfig, seed: string) {
  const rules = createRules(compileGame(game));
  const bot = greedyBot(rules);
  const ids = ['alice', 'bob'];
  const tokens = game.cards.filter((c) => c.token).map((c) => String(c.token!.tokenId));
  const agents = { alice: { stats: normalizeStats({ strength: 40000, agility: 9000, resilience: 60000, intelligence: 100 }), ...(tokens[0] ? { tokenId: tokens[0] } : {}) }, bob: { stats: normalizeStats(null) } };
  let s: MatchState = rules.init(seed, ids, { agents });
  const entries: Array<{ inputs: number[] }> = [];
  while (!rules.done(s)) {
    const inputs = s.phase === 'decks' ? [bot(s, 0), bot(s, 1)] : s.turn === 0 ? [bot(s), 0] : [0, bot(s)];
    s = rules.step(s, { alice: inputs[0], bob: inputs[1] });
    entries.push({ inputs });
  }
  return { rules, record: recordOf(rules, seed, ids, agents, entries), end: s };
}

test('a record survives the share code and replays to the same end', async () => {
  const { rules, record, end } = botMatch(SAMPLE, 'replay-1');
  const code = await encodeRecord(record);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 4000, `share code is ${code.length} chars`);
  const back = await decodeRecord(code);
  assert.deepEqual(back, record);
  const states = replayStates(rules, back);
  assert.deepEqual(states[states.length - 1], end);
  assert.equal(states.length - 1, record.entries.length);
});

test('replay session: starts after the deck phase, seeks by move and turn, flips sides', () => {
  const { rules, record, end } = botMatch(SAMPLE, 'replay-2');
  const r = new ReplaySession(rules, record);
  assert.equal(r.role, 'replay');
  assert.notEqual(r.state.phase, 'decks');
  assert.equal(r.states[r.playStart - 1]?.phase, 'decks');
  r.seek(r.length);
  assert.deepEqual(r.state, end);
  const next = r.turnStart(r.playStart, 1);
  assert.equal(r.states[next].turnNo, r.states[r.playStart].turnNo + 1);
  assert.equal(r.turnStart(next, -1), r.playStart);
  r.seek(-5);
  assert.equal(r.cursor, 0);
  assert.equal(r.you, 'alice');
  r.flip();
  assert.equal(r.you, 'bob');
  assert.equal(r.champions.alice?.tokenId, record.agents.alice.tokenId);
  assert.equal(r.champions.bob, undefined);
  r.act(); r.concede(); r.declareDeck();   // read-only: no-ops
  assert.deepEqual(r.states[r.length], end);
});

test('a practice match records itself, champion tokens included', () => {
  const rules = createRules(compileGame(SAMPLE));
  const token = SAMPLE.cards.find((c) => c.token)!.token!.tokenId;
  const s = new LocalBotSession(rules, 'practice-1', { tokenId: String(token), stats: { strength: 30000 } });
  s.declareDeck(rules.game.suggestedDeck);
  s.close();
  const rec = s.record()!;
  assert.equal(rec.agents.you.tokenId, String(token));
  assert.deepEqual(rec.agents.bot.stats, normalizeStats(null));
  const states = replayStates(rules, rec);
  assert.deepEqual(states[states.length - 1], s.state);
});

test('untrusted records: wrong ruleset, garbage and bad shapes are refused; stats are normalized', async () => {
  const { rules, record } = botMatch(SAMPLE, 'replay-3');
  assert.throws(() => replayStates(rules, { ...record, rulesetId: 'other-game.v1' }), /this replay is from other-game\.v1/);
  await assert.rejects(decodeRecord('not a code!'), /not a replay code/);
  await assert.rejects(decodeRecord('AAAA'), /not a replay code/);
  assert.throws(() => checkRecord({ ...record, participants: ['a', 'a'] }), /two distinct participants/);
  assert.throws(() => checkRecord({ ...record, entries: [[1, 'x']] }), /two integers/);
  const odd = checkRecord({ ...record, agents: { alice: { stats: { strength: 1e9, agility: -4 }, tokenId: 'abc' } } });
  assert.deepEqual(odd.agents.alice, { stats: { strength: 65535, agility: 0, resilience: 0, intelligence: 0 } });
});

test('tessaract replay checks a share link from the command line', async () => {
  const { record, end } = botMatch(SAMPLE, 'replay-4');
  const link = `https://example.test/#replay=${await encodeRecord(record)}`;
  const r = spawnSync(process.execPath, [tsx, join(ROOT, 'src', 'cli.ts'), 'replay', link, '--game', join(ROOT, 'test', 'fixtures', 'sample-duel.game.json')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`result\\s+${end.winner === 2 ? 'draw' : `${record.participants[end.winner as 0 | 1]} won`}`));
  assert.match(r.stdout, /state\s+sha256 [0-9a-f]{64}/);
});

test('relay spectators: get the log so far, every new entry, and cannot act; the cap holds', async () => {
  const port = 8400 + Math.floor(Math.random() * 400);
  const relay = spawn(process.execPath, [tsx, join(ROOT, 'src', 'cli.ts'), 'relay'], {
    cwd: ROOT,
    env: { ...process.env, TCG_DEV: '1', TCG_GAME: STARTER_PATH, TCG_CHAIN: 'off', GAUNTLET_PORT: String(port), TCG_SPECTATORS: '2', TCG_TTL_MS: '20000' },
  });
  type Msg = { t: string; [k: string]: unknown };
  const sockets: WebSocket[] = [];
  const connect = (hello: Record<string, unknown>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    const inbox: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.onmessage = (ev) => { inbox.push(JSON.parse(String(ev.data))); for (const w of waiters.splice(0)) w(); };
    ws.onopen = () => ws.send(JSON.stringify(hello));
    const next = async (t: string): Promise<Msg> => {
      for (;;) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await new Promise<void>((w) => waiters.push(w));
      }
    };
    return { next, send: (m: unknown) => ws.send(JSON.stringify(m)), inbox };
  };
  try {
    await new Promise<void>((ready, fail) => {
      relay.stdout.on('data', (d: Buffer) => { if (d.toString().includes(`:${port}`)) ready(); });
      relay.on('exit', (code) => fail(new Error(`relay exited ${code}`)));
    });
    const early = connect({ t: 'watch' });
    assert.equal((await early.next('watching')).delayMs, 0);
    const alice = connect({ t: 'hello', player: 'alice' });
    const bob = connect({ t: 'hello', player: 'bob' });
    const start = await alice.next('start');
    await bob.next('start');
    const seen = await early.next('start');
    assert.deepEqual(seen.participants, start.participants);
    // Whoever moves first ends their turn; the spectator sees the entry.
    const rules = createRules(compileGame(STARTER));
    const s = rules.init(String(start.seed), start.participants as string[], {});
    const mover = s.turn === 0 ? alice : bob;
    mover.send({ t: 'act', x: endTurn() });
    const entry = (await early.next('entry')).entry as { k: number };
    assert.equal(entry.k, 0);
    // A spectator's actions are ignored.
    early.send({ t: 'act', x: endTurn() });
    // A late spectator gets the log so far in its start; a third one is over the cap of 2.
    const late = connect({ t: 'watch' });
    assert.equal(((await late.next('start')).entries as unknown[]).length, 1);
    const extra = connect({ t: 'watch' });
    assert.match(String((await extra.next('error')).message), /full of spectators/);
    const status = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json()) as { entries: number; spectators: number };
    assert.equal(status.entries, 1, 'the spectator action was not recorded');
    assert.equal(status.spectators, 2);
  } finally {
    for (const ws of sockets) ws.close();
    relay.kill();
  }
});
