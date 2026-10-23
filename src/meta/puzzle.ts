/**
 * The daily puzzle: "win this turn". Every UTC day has one puzzle, the same for every player, generated
 * deterministically from the date: a seeded bot-vs-bot match is played out, and the puzzle is the winner's
 * final turn. So a puzzle is always solvable (the bot solved it), and it is reachable from the match log: a
 * solution is an ordinary match record that anyone can replay to verify. Random lines through the turn
 * rate its difficulty; a puzzle the random line solves too often is skipped.
 * Kernel-compatible: it needs only init, step, legalActions and a bot.
 */
import { declare, decode, Op } from '../core/actions';
import { greedyBot } from '../core/bot';
import { normalizeStats } from '../core/champion';
import { seededRandom } from '../core/rng';
import type { Rules } from '../core/rules';
import type { AgentStats, MatchState } from '../core/types';

export interface Puzzle {
  v: 1;
  /** UTC date, YYYY-MM-DD. */
  date: string;
  seed: string;
  participants: [string, string];
  agents: Record<string, { stats: Required<AgentStats>; tokenId?: string }>;
  /** The log up to the start of the puzzle turn. */
  prefix: Array<[number, number]>;
  /** The side to play (and to win this turn). */
  side: 0 | 1;
  /** Actions in the bot's winning line. */
  par: number;
  /** Share of random lines through the turn that win (lower is harder). */
  odds: number;
}

export type PuzzleStatus = 'playing' | 'solved' | 'failed';

const MAX_ODDS = 0.35;

export function createPuzzles(rules: Rules) {
  const { cards, config } = rules.game;
  const dr = config.deckRules?.mode === 'declared' ? config.deckRules : null;
  const tokens = cards.filter((c) => c.token).map((c) => String(c.token!.tokenId));
  const bot = greedyBot(rules);

  const randomDeck = (rnd: () => number): number[] => {
    if (!dr) return [];
    const list = cards.flatMap((_, c) => Array.from({ length: dr.maxCopies }, () => c));
    for (let i = list.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return list.slice(0, dr.size);
  };

  /** The state at the start of the puzzle turn. */
  const opening = (p: Puzzle): MatchState => {
    let s = rules.init(p.seed, p.participants, { agents: p.agents });
    for (const [a, b] of p.prefix) s = rules.step(s, { [p.participants[0]]: a, [p.participants[1]]: b });
    return s;
  };

  /** Try one candidate match; a puzzle if its last turn is a real puzzle. */
  const candidate = (date: string, k: number, playouts: number): Puzzle | null => {
    const rnd = seededRandom(`puzzle|${date}|${k}`);
    const seed = `puzzle-${date}-${k}`;
    const participants: [string, string] = ['you', 'rival'];
    const agent = () => ({ stats: normalizeStats({ strength: rnd() % 65536, agility: rnd() % 65536, resilience: rnd() % 65536, intelligence: rnd() % 65536 }), ...(tokens.length ? { tokenId: tokens[rnd() % tokens.length] } : {}) });
    const agents = { you: agent(), rival: agent() };
    const decks = [randomDeck(rnd), randomDeck(rnd)];
    let s = rules.init(seed, participants, { agents });
    const entries: Array<[number, number]> = [];
    let turnStart = 0, lastTurn = -1;
    while (!s.over && entries.length < config.litnode.maxTicks) {
      let f: [number, number];
      if (s.phase === 'decks') f = [declare(decks[0][s.decl![0].length]), declare(decks[1][s.decl![1].length])];
      else {
        if (s.turnNo !== lastTurn) { lastTurn = s.turnNo; turnStart = entries.length; }
        const x = bot(s);
        f = s.turn === 0 ? [x, 0] : [0, x];
      }
      entries.push(f);
      s = rules.step(s, { you: f[0], rival: f[1] });
    }
    if (!s.over || (s.winner !== 0 && s.winner !== 1) || s.p[s.winner === 0 ? 1 : 0].life > 0) return null;   // decided by life, not a cap or concede
    const side = s.winner as 0 | 1;
    const prefix = entries.slice(0, turnStart);
    const par = entries.slice(turnStart).filter((f) => decode(f[side]).op !== Op.End).length;
    if (par < 2) return null;
    const puzzle: Puzzle = { v: 1, date, seed, participants, agents, prefix, side, par, odds: 0 };
    const start = opening(puzzle);
    if (start.over || start.turn !== side || start.phase === 'decks') return null;
    // Difficulty: how often a random line through the turn wins.
    const r = seededRandom(`${seed}|playouts`);
    let wins = 0;
    for (let j = 0; j < playouts; j++) {
      let t = start;
      for (let n = 0; n < 40 && !t.over && t.turn === side; n++) {
        const moves = rules.legalActions(t).filter((x) => decode(x).op !== Op.End);
        if (!moves.length) break;
        t = rules.step(t, { [participants[side]]: moves[r() % moves.length] });
      }
      if (t.over && t.winner === side) wins++;
    }
    puzzle.odds = wins / playouts;
    return puzzle.odds <= MAX_ODDS ? puzzle : null;
  };

  return {
    /** Today's puzzle (or any date's): the first candidate match that makes a real puzzle. Null if none in `tries`. */
    daily(date: string, { tries = 40, playouts = 120 }: { tries?: number; playouts?: number } = {}): Puzzle | null {
      for (let k = 0; k < tries; k++) { const p = candidate(date, k, playouts); if (p) return p; }
      return null;
    },
    opening,
    /** Solved when the puzzle side has won; failed once its turn has passed or it lost. */
    status(p: Puzzle, s: MatchState): PuzzleStatus {
      if (s.over) return s.winner === p.side ? 'solved' : 'failed';
      return s.turn === p.side ? 'playing' : 'failed';
    },
  };
}
export type Puzzles = ReturnType<typeof createPuzzles>;
