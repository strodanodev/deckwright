/**
 * Headless balance and determinism check: greedy bots play N matches with random seeds, then every log is
 * replayed from scratch and must reach the same root.
 *
 *   deckwright sim <game.json> [--matches 200] [--decks suggested|random|mixed] [--stats random|base] [--strict]
 *
 * --decks (declared-deck games): `suggested` (default) declares the suggested deck on both sides; `random`
 *   declares a random legal deck per side, so every card gets played and wallet decks get balance numbers;
 *   `mixed` alternates the two.
 * --stats: `random` gives each side a random ERC-6699 champion (the default for a game with a collection);
 *   `base` plays every match without champions (all stats 0, the default for a game without one).
 *
 * Besides balance it reports fun targets: signals that a set plays as more than a race of plain creatures.
 * --strict exits 1 when first-player wins or any fun target misses (for CI).
 */
import { declare, decode, Op } from '../core/actions';
import { greedyBot } from '../core/bot';
import { normalizeStats } from '../core/champion';
import { compileGame } from '../core/game';
import { seededRandom } from '../core/rng';
import { createRules } from '../core/rules';
import type { AgentStats, MatchState } from '../core/types';
import { die, flag, litnodeHash, parseArgs, readGame } from './common';

const usage = 'usage: deckwright sim <game.json> [--matches 200] [--decks suggested|random|mixed] [--stats random|base] [--strict]';
const args = parseArgs();
const game = readGame(args._[0] ?? die(usage));
const matches = Number(flag(args, 'matches') ?? 200);
const declared = game.deckRules?.mode === 'declared';
const decks = flag(args, 'decks') ?? 'suggested';
if (!['suggested', 'random', 'mixed'].includes(decks)) die(usage);
if (decks !== 'suggested' && !declared) die('--decks random|mixed needs deckRules.mode "declared" (every player plays the fixed deck)');
const hasCollection = game.cards.some((c) => c.token);
const statsMode = flag(args, 'stats') ?? (hasCollection ? 'random' : 'base');
if (!['random', 'base'].includes(statsMode)) die(usage);

const rules = createRules(compileGame(game));
const bot = greedyBot(rules);
const players = ['a'.repeat(64), 'b'.repeat(64)];
const rnd = seededRandom('tcg-sim');
const randomStats = (): AgentStats => (statsMode === 'base' ? normalizeStats(null) : { strength: rnd() % 65536, agility: rnd() % 65536, resilience: rnd() % 65536, intelligence: rnd() % 65536 });

/** A random legal deck: deckRules.size cards drawn from the whole card list, at most maxCopies of each. */
function randomDeck(): number[] {
  const { size, maxCopies } = game.deckRules!;
  const pool = game.cards.flatMap((_, c) => Array.from({ length: maxCopies }, () => c));
  for (let i = pool.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, size);
}

let firstWins = 0, secondWins = 0, draws = 0, capped = 0, beats = 0, turns = 0, mismatches = 0;
// Fun telemetry: what attacks hit, what gets played, whether the board decides games, how much champions decide them.
let faceAttacks = 0, unitAttacks = 0, unitPlays = 0, otherPlays = 0, powers = 0, close = 0, boardLed = 0, boardLedWon = 0, edged = 0, edgedWon = 0;
const lengths: number[] = [];
// Per hero power: sides that had it, and how many of those won (only matches between different powers count).
const byPower = new Map<number, { n: number; won: number }>();
const played = new Map<number, number>();
// Per card: matches it was in a side's deck, and how many of those that side won.
const inDeck = new Map<number, { n: number; won: number }>();

for (let m = 0; m < matches; m++) {
  const seed = litnodeHash('seed', `sim-${m}`);
  // A random champion card from the game's collection (for element powers), with random stats.
  const tokenCards = game.cards.filter((c) => c.token);
  const agent = () => ({ stats: randomStats(), ...(statsMode === 'random' && tokenCards.length ? { tokenId: String(tokenCards[rnd() % tokenCards.length].token!.tokenId) } : {}) });
  const ctx = { agents: { [players[0]]: agent(), [players[1]]: agent() } };
  const random = decks === 'random' || (decks === 'mixed' && m % 2 === 1);
  const lists = random ? [randomDeck(), randomDeck()] : null;
  let s: MatchState = rules.init(seed, players, ctx);
  let snap6: MatchState | null = null;
  const first = s.turn;
  const log: Array<Record<string, number>> = [];
  while (!rules.done(s)) {
    // Deck phase: both sides declare in the same entry. Play phase: only the side to act moves.
    const frame = s.phase === 'decks'
      ? { [players[0]]: lists ? declare(lists[0][s.decl![0].length]) : bot(s, 0), [players[1]]: lists ? declare(lists[1][s.decl![1].length]) : bot(s, 1) }
      : { [players[0]]: 0, [players[1]]: 0, [s.p[s.turn].id]: bot(s) };
    const hand = s.p[s.turn].hand;
    s = rules.step(s, frame);
    if (s.last && s.phase !== 'decks') {
      const d = decode(s.last);
      if (d.op === Op.Play) { const c = hand[d.a]; played.set(c, (played.get(c) ?? 0) + 1); if (game.cards[c].type === 'unit') unitPlays++; else otherPlays++; }
      else if (d.op === Op.Attack) { if (d.target === 0) faceAttacks++; else unitAttacks++; }
      else if (d.op === Op.Power) powers++;
    }
    if (!snap6 && s.turnNo >= 13) snap6 = s;   // after each side's sixth turn
    log.push(frame);
  }
  // Replay: the node and witnesses only ever see the seed, ctx and this log.
  let r = rules.init(seed, players, ctx);
  for (const f of log) r = rules.step(r, f);
  if (JSON.stringify(rules.serialize(r)) !== JSON.stringify(rules.serialize(s))) mismatches++;

  beats += s.beat; turns += s.turnNo;
  if (s.beat >= game.litnode.maxTicks) capped++;
  if (s.winner === 2) draws++;
  else if (s.winner === first) firstWins++;
  else secondWins++;
  lengths.push(s.turnNo);
  if (s.p[0].power !== s.p[1].power) for (const side of [0, 1] as const) {
    const e = byPower.get(s.p[side].power) ?? { n: 0, won: 0 };
    e.n++; if (s.winner === side) e.won++;
    byPower.set(s.p[side].power, e);
  }
  if (s.winner === 0 || s.winner === 1) {
    const w = s.winner, l = w === 0 ? 1 : 0;
    if (s.p[w].life <= 5) close++;
    const bp = (st: MatchState, i: 0 | 1): number => st.p[i].board.reduce((n, u) => n + u.atk + u.hp, 0);
    if (snap6 && bp(snap6, 0) !== bp(snap6, 1)) { boardLed++; if (bp(snap6, w) > bp(snap6, l)) boardLedWon++; }
    const gap = s.p[w].maxLife - s.p[l].maxLife;
    if (Math.abs(gap) >= 4) { edged++; if (gap > 0) edgedWon++; }
  }
  const deckOf = (side: 0 | 1): number[] => (s.decl ? s.decl[side] : rules.game.deckList);
  for (const side of [0, 1] as const) {
    for (const c of new Set(deckOf(side))) {
      const e = inDeck.get(c) ?? { n: 0, won: 0 };
      e.n++; if (s.winner === side) e.won++;
      inDeck.set(c, e);
    }
  }
}

const pct = (n: number, of = matches): string => `${((100 * n) / of).toFixed(1)}%`;
console.log(`${game.title} (${game.litnode.rulesetId}): ${matches} bot matches · decks ${declared ? decks : 'fixed'} · champions ${statsMode}`);
console.log(`  first player wins  ${pct(firstWins)}`);
console.log(`  second player wins ${pct(secondWins)}`);
console.log(`  draws              ${pct(draws)}`);
console.log(`  hit maxTicks       ${pct(capped)}  (raise litnode.maxTicks if this is high)`);
console.log(`  avg log entries    ${(beats / matches).toFixed(0)} of ${game.litnode.maxTicks}`);
console.log(`  avg turns          ${(turns / matches).toFixed(1)}`);
console.log(`  replay mismatches  ${mismatches}`);
const unplayed = game.cards.filter((_, c) => !played.has(c)).map((c) => c.id);
if (unplayed.length) console.log(`  never played       ${unplayed.join(', ')}`);
// With random decks every card shows up in many decks, so its deck win rate says something about its strength.
if (decks !== 'suggested') {
  const rated = [...inDeck.entries()].filter(([, e]) => e.n >= 20).map(([c, e]) => ({ id: game.cards[c].id, rate: e.won / e.n })).sort((a, b) => b.rate - a.rate);
  const fmt = (x: { id: string; rate: number }): string => `${x.id} ${(100 * x.rate).toFixed(0)}%`;
  if (rated.length >= 6) {
    console.log(`  strongest in deck  ${rated.slice(0, 5).map(fmt).join(', ')}`);
    console.log(`  weakest in deck    ${rated.slice(-5).reverse().map(fmt).join(', ')}`);
  }
}

// Fun targets. They are measured with the house bot, so read them as signals about the card set, not about people.
const mean = lengths.reduce((a, b) => a + b, 0) / matches;
const spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / matches);
const share = (a: number, b: number): number => (b ? a / b : 0);
const targets: Array<[string, string, boolean | null, string]> = [
  ['first player wins', pct(firstWins), firstWins / matches >= 0.45 && firstWins / matches <= 0.55, '45-55%'],
  ['attacks at the champion', `${(100 * share(faceAttacks, faceAttacks + unitAttacks)).toFixed(0)}%`, share(faceAttacks, faceAttacks + unitAttacks) <= 0.85, 'at most 85%: units should fight units'],
  ['spells, relics, powers', `${(100 * share(otherPlays + powers, unitPlays + otherPlays + powers)).toFixed(0)}% of plays`, share(otherPlays + powers, unitPlays + otherPlays + powers) >= 0.15, 'at least 15%'],
  ['board leader wins', boardLed >= 20 ? `${(100 * share(boardLedWon, boardLed)).toFixed(0)}%` : 'n/a', boardLed >= 20 ? share(boardLedWon, boardLed) >= 0.5 : null, 'at least 50% (after 6 turns each)'],
  ['champion edge wins', edged >= 20 ? `${(100 * share(edgedWon, edged)).toFixed(0)}%` : 'n/a', edged >= 20 ? share(edgedWon, edged) <= 0.62 : null, 'at most 62% (4+ more starting life)'],
  ['close finishes', pct(close), close / matches >= 0.15, 'at least 15% (winner on 5 life or less)'],
  ['match length spread', `±${spread.toFixed(1)} turns`, spread >= 2, 'at least ±2 turns'],
];
console.log('  fun targets (house bot):');
for (const [name, value, ok, want] of targets) console.log(`    ${ok === null ? '·' : ok ? '✓' : '✗'} ${name.padEnd(24)} ${value.padEnd(14)} ${want}`);
if (powers) {
  const list = game.champion.powers ?? [];
  const rates = [...byPower.entries()].filter(([, e]) => e.n >= 20).map(([i, e]) => `${i >= 0 ? list[i].name : 'none'} ${(100 * e.won / e.n).toFixed(0)}%`);
  console.log(`    hero powers used ${(powers / matches).toFixed(1)} per match${rates.length ? ` · win rate by power: ${rates.join(', ')}` : ''}`);
}
const missed = targets.filter(([, , ok]) => ok === false).length;
process.exit(mismatches || (args.strict && missed) ? 1 : 0);
