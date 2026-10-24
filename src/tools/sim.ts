/**
 * Headless balance and determinism check: greedy bots play N matches with random seeds, then every log is
 * replayed from scratch and must reach the same root. The harness is `simulate` (src/meta/balance.ts), shared
 * with Tessaract Studio; this command parses flags and prints its report.
 *
 *   tessaract sim <game.json> [--matches 200] [--decks suggested|random|mixed] [--stats random|base] [--strict]
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
import { simulate } from '../meta/balance';
import type { DeckMode, StatsMode } from '../meta/balance';
import { die, flag, litnodeHash, parseArgs, readGame } from './common';

const usage = 'usage: tessaract sim <game.json> [--matches 200] [--decks suggested|random|mixed] [--stats random|base] [--strict]';
const args = parseArgs();
const game = readGame(args._[0] ?? die(usage));
const decks = flag(args, 'decks') ?? 'suggested';
if (!['suggested', 'random', 'mixed'].includes(decks)) die(usage);
if (decks !== 'suggested' && game.deckRules?.mode !== 'declared') die('--decks random|mixed needs deckRules.mode "declared" (every player plays the fixed deck)');
const stats = flag(args, 'stats');
if (stats !== undefined && !['random', 'base'].includes(stats)) die(usage);

const r = simulate(game, {
  matches: Number(flag(args, 'matches') ?? 200),
  decks: decks as DeckMode,
  stats: stats as StatsMode | undefined,
  // LitNode-style seeds, as the node derives them: the numbers match every earlier release of this command.
  seedOf: (m) => litnodeHash('seed', `sim-${m}`),
});

const pct = (n: number): string => `${((100 * n) / r.matches).toFixed(1)}%`;
console.log(`${r.title} (${r.rulesetId}): ${r.matches} bot matches · decks ${r.decks} · champions ${r.stats}`);
console.log(`  first player wins  ${pct(r.firstWins)}`);
console.log(`  second player wins ${pct(r.secondWins)}`);
console.log(`  draws              ${pct(r.draws)}`);
console.log(`  hit maxTicks       ${pct(r.capped)}  (raise litnode.maxTicks if this is high)`);
console.log(`  avg log entries    ${r.avgEntries.toFixed(0)} of ${r.maxTicks}`);
console.log(`  avg turns          ${r.avgTurns.toFixed(1)}`);
console.log(`  replay mismatches  ${r.mismatches}`);
if (r.neverPlayed.length) console.log(`  never played       ${r.neverPlayed.join(', ')}`);
const fmt = (x: { id: string; rate: number }): string => `${x.id} ${(100 * x.rate).toFixed(0)}%`;
if (r.strongest.length) {
  console.log(`  strongest in deck  ${r.strongest.map(fmt).join(', ')}`);
  console.log(`  weakest in deck    ${r.weakest.map(fmt).join(', ')}`);
}
console.log('  fun targets (house bot):');
for (const t of r.targets) console.log(`    ${t.ok === null ? '·' : t.ok ? '✓' : '✗'} ${t.name.padEnd(24)} ${t.value.padEnd(14)} ${t.want}`);
if (r.powersPerMatch) {
  const rates = r.powerRates.map((p) => `${p.name} ${(100 * p.rate).toFixed(0)}%`);
  console.log(`    hero powers used ${r.powersPerMatch.toFixed(1)} per match${rates.length ? ` · win rate by power: ${rates.join(', ')}` : ''}`);
}
process.exit(r.mismatches || (args.strict && r.missed) ? 1 : 0);
