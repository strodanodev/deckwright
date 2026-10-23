import { decode, Op } from './actions';
import type { Rules } from './rules';
import type { MatchState } from './types';

/**
 * A greedy, deterministic opponent: plays the action that most improves a simple board score,
 * ends the turn when nothing helps. Used by the offline client, the headless sim and as a
 * stand-in for AFK players in tests. Not part of any ruleset.
 */
export function greedyBot(rules: Rules): (state: MatchState) => number {
  const score = (s: MatchState, me: 0 | 1): number => {
    if (s.over) return s.winner === me ? 1e6 : s.winner === 2 ? 0 : -1e6;
    const P = s.p[me], E = s.p[me === 0 ? 1 : 0];
    const board = (units: MatchState['p'][0]['board']): number => units.reduce((n, u) => n + u.atk * 2 + u.hp, 0);
    // Relics pay off over turns and spare energy enables more plays, so both count a little.
    return (P.life - E.life) * 3 + board(P.board) - board(E.board) + P.hand.length - E.hand.length + P.relics.length * 4 + P.energy * 0.5;
  };
  return (state) => {
    const me = state.turn;
    const id = state.p[me].id;
    let best = 0, bestScore = -Infinity;
    const legal = rules.legalActions(state);
    for (const x of legal) {
      if (decode(x).op === Op.End) continue;
      const next = rules.step(state, { [id]: x });
      const v = score(next, me);
      if (v > bestScore) { bestScore = v; best = x; }
    }
    // Spend the turn while anything is legal and not worse than passing.
    const pass = score(state, me);
    return best !== 0 && bestScore >= pass ? best : legal[legal.length - 1] ?? 0;
  };
}
