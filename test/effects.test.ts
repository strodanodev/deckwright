import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { attack, compileGame, createRules, describeCard, endTurn, enemyUnit, greedyBot, ownUnit, play, power, validateGame } from '../src/core/index';
import type { CardDef, GameConfig, MatchState } from '../src/core/index';
import { archetypes, kitPowers, kitSupport, kitUnit } from '../src/tools/design-kit';

const STARTER = JSON.parse(readFileSync(new URL('../templates/starter.game.json', import.meta.url), 'utf8')) as GameConfig;
const unit = (id: string, attackV: number, health: number, extra: Partial<CardDef> = {}): CardDef => ({ id, name: id, type: 'unit', element: 'neutral', cost: 1, attack: attackV, health, rarity: 'common', ...extra });
const spell = (id: string, effect: CardDef['effect']): CardDef => ({ id, name: id, type: 'spell', element: 'neutral', cost: 1, effect, rarity: 'common' });

/** A test game: the starter's rules plus the given cards (each also in the deck so the config validates). */
function setup(cards: CardDef[], champion: Partial<GameConfig['champion']> = {}) {
  const cfg: GameConfig = { ...STARTER, champion: { ...STARTER.champion, ...champion }, rules: { ...STARTER.rules, secondPlayerCards: 0, secondPlayerEnergy: 0 }, cards, deck: Object.fromEntries(cards.map((c) => [c.id, 3])) };
  assert.deepEqual(validateGame(cfg), []);
  const rules = createRules(compileGame(cfg));
  const idx = (id: string): number => cards.findIndex((c) => c.id === id);
  /** A fresh match with side `turn` to act, hands and boards cleared, plenty of energy. */
  const fresh = (): MatchState => {
    const s = rules.init('effects', ['a', 'b'], {});
    for (const p of s.p) { p.hand = []; p.board = []; p.energy = 10; p.energyCap = 10; p.life = 20; p.maxLife = 30; }
    return s;
  };
  const put = (s: MatchState, side: 0 | 1, id: string, ready = true) => {
    const c = idx(id), def = cards[c];
    const u = { c, atk: def.attack!, hp: def.health!, max: def.health!, guard: def.keywords?.includes('guard') ?? false, ready, fresh: !ready, shield: def.keywords?.includes('shield') ?? false };
    s.p[side].board.push(u);
    return u;
  };
  const act = (s: MatchState, x: number): MatchState => rules.step(s, { [s.p[s.turn].id]: x });
  return { rules, idx, fresh, put, act };
}

test('keywords: shield blocks one hit, poison destroys, lifesteal heals, guard redirects', () => {
  const g = setup([unit('knight', 3, 3, { keywords: ['shield'] }), unit('adder', 1, 1, { keywords: ['poison'] }), unit('leech', 2, 4, { keywords: ['lifesteal'] }), unit('wall', 0, 9, { keywords: ['guard'] }), unit('ogre', 5, 9)]);
  const id = (s: MatchState, side: 0 | 1) => s.p[side].board.map((u) => g.rules.game.cards[u.c].id);
  // Shield: the first hit is blocked, and the shield is spent.
  let s = g.fresh();
  let me = s.turn, foe: 0 | 1 = me === 0 ? 1 : 0;
  g.put(s, me, 'leech'); g.put(s, foe, 'knight');
  s = g.act(s, attack(0, enemyUnit(0)));
  assert.deepEqual([s.p[foe].board[0].hp, s.p[foe].board[0].shield], [3, false]);
  // Poison: 1 damage destroys a 9-health unit (and the ogre's 5 back kills the adder).
  s = g.fresh();
  me = s.turn; foe = me === 0 ? 1 : 0;
  g.put(s, me, 'adder'); g.put(s, foe, 'ogre');
  s = g.act(s, attack(0, enemyUnit(0)));
  assert.deepEqual([id(s, me), id(s, foe)], [[], []]);
  // Lifesteal: damage dealt heals the champion.
  s = g.fresh();
  me = s.turn;
  g.put(s, me, 'leech');
  const before = s.p[me].life;
  s = g.act(s, attack(0, 0));
  assert.equal(s.p[me].life, before + 2);
  // Guard: the champion can't be attacked past it.
  s = g.fresh();
  g.put(s, s.turn, 'ogre'); g.put(s, s.turn === 0 ? 1 : 0, 'wall');
  assert.equal(g.rules.isLegal(s, attack(0, 0)), false);
  assert.equal(g.rules.isLegal(s, attack(0, enemyUnit(0))), true);
});

test('rush hits units but not the champion on its first turn; haste hits anything', () => {
  const g = setup([unit('raider', 3, 2, { keywords: ['rush'] }), unit('sprinter', 2, 2, { keywords: ['haste'] }), unit('dummy', 0, 5)]);
  let s = g.fresh();
  const me = s.turn;
  s.p[me].hand = [g.idx('raider'), g.idx('sprinter')];
  g.put(s, me === 0 ? 1 : 0, 'dummy');
  s = g.act(s, play(0, 0));
  assert.equal(g.rules.isLegal(s, attack(0, 0)), false);
  assert.equal(g.rules.isLegal(s, attack(0, enemyUnit(0))), true);
  s = g.act(s, play(0, 0));
  assert.equal(g.rules.isLegal(s, attack(1, 0)), true);
});

test('elusive: enemy spells cannot choose it, but area effects still hit it', () => {
  const g = setup([unit('ghost', 2, 2, { keywords: ['elusive'] }), spell('bolt', { op: 'damage', amount: 3 }), spell('storm', { op: 'damage', amount: 1, target: 'all-enemy-units' })]);
  let s = g.fresh();
  const me = s.turn;
  g.put(s, me === 0 ? 1 : 0, 'ghost');
  s.p[me].hand = [g.idx('bolt'), g.idx('storm')];
  assert.equal(g.rules.isLegal(s, play(0, enemyUnit(0))), false);
  assert.equal(g.rules.isLegal(s, play(0, 0)), true);
  s = g.act(s, play(1, 0));
  assert.equal(s.p[me === 0 ? 1 : 0].board[0].hp, 1);
});

test('abilities: play (chosen, fizzles with no target), death, turn start and attack', () => {
  const g = setup([
    unit('sniper', 1, 1, { abilities: [{ on: 'play', effect: { op: 'damage', amount: 2, target: 'enemy-unit' } }] }),
    unit('golem', 1, 1, { abilities: [{ on: 'death', effect: { op: 'summon', card: 'pup', count: 2 } }] }),
    unit('pup', 1, 1),
    unit('tree', 0, 2, { abilities: [{ on: 'turnStart', effect: { op: 'buff', health: 1, target: 'this' } }] }),
    unit('brute', 2, 5, { abilities: [{ on: 'attack', effect: { op: 'damage', amount: 1, target: 'enemy-champion' } }] }),
  ]);
  let s = g.fresh();
  const me = s.turn, foe = me === 0 ? 1 : 0;
  s.p[me].hand = [g.idx('sniper'), g.idx('sniper'), g.idx('tree')];
  // No enemy unit: the play ability fizzles, so only target 0 is legal.
  assert.deepEqual(g.rules.legalActions(s).filter((x) => (x & 7) === 1 && ((x >>> 3) & 15) === 0), [play(0, 0)]);
  g.put(s, foe, 'golem');
  assert.equal(g.rules.isLegal(s, play(0, 0)), false, 'with a target available, the ability must aim');
  s = g.act(s, play(0, enemyUnit(0)));   // kills the golem: two pups arrive
  assert.deepEqual(s.p[foe].board.map((u) => g.rules.game.cards[u.c].id), ['pup', 'pup']);
  assert.deepEqual(s.p[me].hand.map((c) => g.rules.game.cards[c].id), ['sniper', 'tree']);
  s = g.act(s, play(1, 0));               // the tree
  assert.equal(s.p[me].board.length, 2);
  s = g.act(g.act(s, endTurn()), endTurn());
  const tree = s.p[me].board.find((u) => g.rules.game.cards[u.c].id === 'tree');
  assert.equal(tree?.hp, 3, 'turn start: +0/+1');
  const b = g.fresh();
  g.put(b, b.turn, 'brute');
  const lifeBefore = b.p[b.turn === 0 ? 1 : 0].life;
  const after = g.act(b, attack(0, 0));
  assert.equal(after.p[b.turn === 0 ? 1 : 0].life, lifeBefore - 3, 'attack ability (1) plus the hit (2)');
});

test('hero powers: chosen by the champion card element, once per turn, for energy', () => {
  const cfg = { ...STARTER, cards: [...STARTER.cards.map((c) => (c.id === 'ember-scout' ? { ...c, token: { chainId: 1, collection: '0x01', tokenId: '7' } } : c))] };
  const g = setup(cfg.cards, { powers: [{ id: 'fire', name: 'Fire', cost: 2, element: 'fire', effect: { op: 'damage', amount: 2, target: 'enemy-champion' } }, { id: 'rally', name: 'Rally', cost: 2, effect: { op: 'buff', attack: 1, health: 1 } }] });
  assert.equal(g.rules.heroPower({ tokenId: '7' })?.id, 'fire');
  assert.equal(g.rules.heroPower({})?.id, 'rally');
  let s = g.rules.init('powers', ['a', 'b'], { agents: { a: { tokenId: '7' }, b: {} } });
  const a = s.p[0].id === 'a' ? 0 : 1;
  if (s.turn !== a) s = g.act(s, endTurn());
  s.p[a].energy = 5;
  const foeLife = s.p[a === 0 ? 1 : 0].life;
  s = g.act(s, power(0));
  assert.equal(s.p[a === 0 ? 1 : 0].life, foeLife - 2);
  assert.equal(s.p[a].energy, 3);
  assert.equal(g.rules.isLegal(s, power(0)), false, 'once per turn');
});

test('draws depend on the match log: the same seed with different actions draws differently, and replays exactly', () => {
  const rules = createRules(compileGame(STARTER));
  const bot = greedyBot(rules);
  const run = (skipFirst: boolean) => {
    let s = rules.init('draws', ['a', 'b'], {});
    const log: Record<string, number>[] = [];
    let first = true;
    while (!s.over && s.turnNo < 12) {
      const x = first && skipFirst ? endTurn() : bot(s);
      first = false;
      const f = { [s.p[s.turn].id]: x };
      log.push(f);
      s = rules.step(s, f);
    }
    return { s, log };
  };
  const a = run(false), b = run(true);
  assert.notDeepEqual(a.s.p.map((p) => p.hand), b.s.p.map((p) => p.hand), 'different play, different draws');
  let r = rules.init('draws', ['a', 'b'], {});
  for (const f of a.log) r = rules.step(r, f);
  assert.deepEqual(r, a.s, 'replay reaches the same state');
});

test('validation: automatic contexts reject chosen targets; summons must name units', () => {
  const bad = (c: CardDef) => validateGame({ ...STARTER, cards: [...STARTER.cards, c] });
  assert.ok(bad(unit('x', 1, 1, { abilities: [{ on: 'death', effect: { op: 'damage', amount: 1, target: 'enemy-unit' } }] })).some((e) => e.includes('needs a choice')));
  assert.ok(bad(unit('y', 1, 1, { abilities: [{ on: 'play', effect: { op: 'summon', card: 'spark' } }] })).some((e) => e.includes('not a unit card')));
  assert.ok(bad(unit('z', 1, 1, { keywords: ['flying' as never] })).some((e) => e.includes('unknown keyword')));
});

test('card text and the design kit', () => {
  assert.deepEqual(describeCard(unit('a', 1, 1, { keywords: ['guard'], abilities: [{ on: 'death', effect: { op: 'summon', card: 'pup', count: 2 } }] }), () => 'Pup'), ['Guard', 'Last words: Summon 2 Pups']);
  const arch = archetypes(['earth', 'lava', 'metal', 'water']);
  assert.deepEqual(arch, { earth: 'defense', lava: 'aggro', metal: 'value', water: 'control' });
  const kitted = kitUnit(unit('u', 3, 4, { element: 'lava', cost: 3 }), 'aggro', 3);
  assert.equal(kitted.abilities?.[0].on, 'play');
  assert.equal((kitted.attack ?? 0) + (kitted.health ?? 0), 5, 'the kit is paid for in stats');
  const els = [{ id: 'lava', name: 'Lava' }, { id: 'metal', name: 'Metal' }];
  assert.ok(kitSupport(els, arch).some((c) => c.id === 'construct'));
  assert.deepEqual(kitPowers(els, arch, true).map((p) => p.name), ['Lava Strike', 'Metal Forge', 'Rally']);
});
