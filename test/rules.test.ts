import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { attack, compileGame, concede, createRules, declare, decode, endTurn, greedyBot, Op, play, validateGame } from '../src/core/index';
import type { GameConfig, MatchState } from '../src/core/index';

const load = (p: string): GameConfig => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as GameConfig;
const STARTER = load('../templates/starter.game.json');
const GAMES = readdirSync(new URL('../games/', import.meta.url)).filter((f) => f.endsWith('.game.json')).map((f) => [f, load(`../games/${f}`)] as const);

test('the starter template and every game validate', () => {
  assert.deepEqual(validateGame(STARTER), []);
  for (const [f, g] of GAMES) assert.deepEqual(validateGame(g), [], f);
});

test('validation names the problem', () => {
  const bad = { ...STARTER, litnode: { ...STARTER.litnode, rulesetId: 'Bad Id' }, deck: { 'no-such-card': 3 } };
  const errs = validateGame(bad);
  assert.ok(errs.some((e) => e.includes('rulesetId')));
  assert.ok(errs.some((e) => e.includes('no-such-card')));
});

test('action encoding round-trips', () => {
  assert.deepEqual(decode(play(3, 11)), { op: Op.Play, a: 3, target: 11 });
  assert.deepEqual(decode(attack(4, 2)), { op: Op.Attack, a: 4, target: 2 });
  assert.equal(decode(endTurn()).op, Op.End);
  assert.equal(decode(concede()).op, Op.Concede);
});

function playOut(cfg: GameConfig, seed: string): { final: MatchState; log: Array<Record<string, number>> } {
  const rules = createRules(compileGame(cfg));
  const bot = greedyBot(rules);
  const ctx = { agents: { a: { stats: { strength: 40000, agility: 20000, resilience: 50000, intelligence: 30000 } }, b: { stats: {} } } };
  let s = rules.init(seed, ['a', 'b'], ctx);
  const log: Array<Record<string, number>> = [];
  while (!rules.done(s)) {
    // Deck phase (declared-deck games): both sides declare in one entry. Play phase: the side to act.
    const frame = s.phase === 'decks'
      ? { a: bot(s, 0), b: bot(s, 1) }
      : (() => { const x = bot(s); assert.ok(rules.isLegal(s, x)); return { a: 0, b: 0, [s.p[s.turn].id]: x }; })();
    s = rules.step(s, frame);
    log.push(frame);
  }
  let r = rules.init(seed, ['a', 'b'], ctx);
  for (const f of log) r = rules.step(r, f);
  assert.deepEqual(rules.serialize(r), rules.serialize(s), 'replay reaches the same state');
  return { final: s, log };
}

test('bot matches finish before the tick cap and replay identically', () => {
  for (const cfg of [STARTER, ...GAMES.map(([, g]) => g)]) {
    for (let i = 0; i < 20; i++) {
      const { final } = playOut(cfg, `seed-${i}`);
      assert.ok(final.winner >= 0);
      assert.ok(final.beat < cfg.litnode.maxTicks);
    }
  }
});

test('garbage frames are no-ops, never throws', () => {
  const rules = createRules(compileGame(STARTER));
  let s = rules.init('garbage', ['a', 'b'], {});
  for (let i = 0; i < 400 && !rules.done(s); i++) s = rules.step(s, { a: Math.imul(i, 2654435761), b: Math.imul(i, 40503) });
  assert.equal(typeof rules.done(s), 'boolean');
});

test('concede is honoured from either side, even off-turn', () => {
  const rules = createRules(compileGame(STARTER));
  const s = rules.init('c', ['a', 'b'], {});
  const idle = s.p[s.turn === 0 ? 1 : 0].id;
  const after = rules.step(s, { [idle]: concede() });
  assert.equal(after.over, true);
  assert.equal(after.p[after.winner as 0 | 1].id === idle, false);
});

test('ERC-6699 stats map into the configured bounds', () => {
  const rules = createRules(compileGame(STARTER));
  const lo = rules.champion({ strength: 0, agility: 0, resilience: 0, intelligence: 0 });
  const hi = rules.champion({ strength: 65535, agility: 65535, resilience: 65535, intelligence: 65535 });
  assert.equal(lo.life, STARTER.champion.life.min);
  assert.equal(hi.life, STARTER.champion.life.max);
  assert.equal(hi.openingHand, STARTER.champion.openingHand.max);
});

test('declared decks: each side declares its own cards, shuffled from the seed, then play starts', () => {
  const cfg: GameConfig = { ...STARTER, deckRules: { mode: 'declared', size: 10, maxCopies: 2 } };
  assert.deepEqual(validateGame(cfg), []);
  const rules = createRules(compileGame(cfg));
  const idx = (id: string): number => cfg.cards.findIndex((c) => c.id === id);
  // Two copies each of five cards: exactly the 10-card size, within maxCopies.
  const mine = ['ember-scout', 'spark', 'tide-warden', 'quake', 'storm-hawk'].flatMap((id) => [idx(id), idx(id)]);
  let s = rules.init('decks', ['a', 'b'], {});
  assert.equal(s.phase, 'decks');
  assert.equal(s.p[0].hand.length, 0);
  // A third copy is over maxCopies: a no-op, never a throw.
  const after = rules.step(rules.step(rules.step(s, { a: declare(idx('spark')) }), { a: declare(idx('spark')) }), { a: declare(idx('spark')) });
  assert.equal(after.decl![0].length, 2);
  assert.equal(rules.isLegal(after, declare(idx('spark')), 0), false);
  assert.equal(rules.isLegal(after, play(0), 0), false, 'no play actions before both decks are in');
  for (let i = 0; i < 10; i++) s = rules.step(s, { a: declare(mine[i]), b: rules.suggestedDeclaration(s, 1) });
  assert.equal(s.phase, 'play');
  const all = [...s.p[0].deck, ...s.p[0].hand].sort();
  assert.deepEqual(all, [...mine].sort(), 'side a plays exactly the cards it declared');
  assert.ok(s.p[0].hand.length > 0 && s.turnNo === 1);
});

test('declared decks: validation needs a default deck large enough to suggest from', () => {
  const errs = validateGame({ ...STARTER, deckRules: { mode: 'declared', size: 60, maxCopies: 2 } });
  assert.ok(errs.some((e) => e.includes('deckRules.size')));
});
