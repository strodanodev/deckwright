/**
 * Headless balance and determinism check: greedy bots play N matches with random seeds and random
 * ERC-6699 champion stats, then every log is replayed from scratch and must reach the same root.
 *
 *   deckwright sim <game.json> [--matches 200]
 */
import { compileGame } from '../core/game';
import { createRules } from '../core/rules';
import { greedyBot } from '../core/bot';
import { seededRandom } from '../core/rng';
import type { AgentStats, MatchState } from '../core/types';
import { die, flag, litnodeHash, parseArgs, readGame } from './common';

const args = parseArgs();
const game = readGame(args._[0] ?? die('usage: deckwright sim <game.json> [--matches 200]'));
const matches = Number(flag(args, 'matches') ?? 200);
const rules = createRules(compileGame(game));
const bot = greedyBot(rules);
const players = ['a'.repeat(64), 'b'.repeat(64)];
const rnd = seededRandom('tcg-sim');
const randomStats = (): AgentStats => ({ strength: rnd() % 65536, agility: rnd() % 65536, resilience: rnd() % 65536, intelligence: rnd() % 65536 });

let firstWins = 0, secondWins = 0, draws = 0, capped = 0, beats = 0, turns = 0, mismatches = 0;
const cardsPlayed = new Map<string, number>();

for (let m = 0; m < matches; m++) {
  const seed = litnodeHash('seed', `sim-${m}`);
  const ctx = { agents: { [players[0]]: { stats: randomStats() }, [players[1]]: { stats: randomStats() } } };
  let s: MatchState = rules.init(seed, players, ctx);
  const first = s.turn;
  const log: Array<Record<string, number>> = [];
  while (!rules.done(s)) {
    // Deck phase: both sides declare in the same entry. Play phase: only the side to act moves.
    const x = bot(s);
    const frame = s.phase === 'decks'
      ? { [players[0]]: bot(s, 0), [players[1]]: bot(s, 1) }
      : { [players[0]]: 0, [players[1]]: 0, [s.p[s.turn].id]: x };
    const hand = s.p[s.turn].hand;
    s = rules.step(s, frame);
    if (s.last && (s.last & 7) === 1) { const c = game.cards[hand[(s.last >>> 3) & 15]]; cardsPlayed.set(c.id, (cardsPlayed.get(c.id) ?? 0) + 1); }
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
}

const pct = (n: number): string => `${((100 * n) / matches).toFixed(1)}%`;
console.log(`${game.title} (${game.litnode.rulesetId}): ${matches} bot matches`);
console.log(`  first player wins  ${pct(firstWins)}`);
console.log(`  second player wins ${pct(secondWins)}`);
console.log(`  draws              ${pct(draws)}`);
console.log(`  hit maxTicks       ${pct(capped)}  (raise litnode.maxTicks if this is high)`);
console.log(`  avg log entries    ${(beats / matches).toFixed(0)} of ${game.litnode.maxTicks}`);
console.log(`  avg turns          ${(turns / matches).toFixed(1)}`);
console.log(`  replay mismatches  ${mismatches}`);
const unplayed = game.cards.filter((c) => !cardsPlayed.has(c.id)).map((c) => c.id);
if (unplayed.length) console.log(`  never played       ${unplayed.join(', ')}`);
process.exit(mismatches ? 1 : 0);
