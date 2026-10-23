import { decode, Op } from './actions';
import type { Rules } from './rules';
import type { MatchState, UnitState } from './types';

/**
 * A greedy, deterministic opponent: plays the action that most improves a board score, ends the turn when
 * nothing helps. Setup plays (non-unit cards and hero powers) get a second look one action deeper, so it
 * spends energy and draw cards when they lead somewhere. Used by the offline client, the headless sim and
 * as a stand-in for AFK players in tests. Not part of any ruleset.
 */
export function greedyBot(rules: Rules): (state: MatchState, side?: 0 | 1) => number {
  const cards = rules.game.cards;
  const has = (u: UnitState, k: string): boolean => cards[u.c].keywords?.includes(k as never) ?? false;
  const unitValue = (u: UnitState): number =>
    u.atk * 2 + u.hp + (u.guard ? 1 : 0) + (u.shield ? u.atk + 1 : 0) + (has(u, 'lifesteal') ? u.atk * 0.5 : 0) + (has(u, 'poison') ? 3 : 0) + (cards[u.c].abilities?.some((a) => a.on === 'turnStart' || a.on === 'death') ? 2 : 0);
  // Life gets more valuable as it runs out, for both sides: defend when low, press when the enemy is low.
  const lifeValue = (l: number): number => 3 * l - 0.15 * Math.max(0, 15 - l) ** 2;
  const score = (s: MatchState, me: 0 | 1): number => {
    if (s.over) return s.winner === me ? 1e6 : s.winner === 2 ? 0 : -1e6;
    const P = s.p[me], E = s.p[me === 0 ? 1 : 0];
    const board = (units: UnitState[]): number => units.reduce((n, u) => n + unitValue(u), 0);
    // The enemy's board next turn, past my guards: facing lethal is nearly as bad as losing.
    const threat = E.board.reduce((n, u) => n + u.atk, 0) - P.board.filter((u) => u.guard).reduce((n, u) => n + u.hp, 0);
    const danger = threat >= P.life ? 40 : 0;
    // Relics pay off over turns and spare energy enables more plays, so both count a little.
    return lifeValue(P.life) - lifeValue(E.life) + 1.5 * (board(P.board) - board(E.board)) + P.hand.length - E.hand.length + P.relics.length * 4 + P.energy * 0.5 - danger;
  };
  const isSetup = (s: MatchState, x: number): boolean => {
    const { op, a } = decode(x);
    if (op === Op.Power) return true;
    if (op !== Op.Play) return false;
    const c = s.p[s.turn].hand[a];
    return c !== undefined && cards[c].type !== 'unit';
  };
  const bestOf = (state: MatchState, me: 0 | 1, deeper: boolean): { x: number; v: number } => {
    const id = state.p[me].id;
    let best = 0, bestScore = -Infinity;
    for (const x of rules.legalActions(state)) {
      if (decode(x).op === Op.End) continue;
      const next = rules.step(state, { [id]: x });
      let v = score(next, me);
      if (deeper && isSetup(state, x) && !next.over && next.turn === me) v = Math.max(v, bestOf(next, me, false).v - 0.1);
      if (v > bestScore) { bestScore = v; best = x; }
    }
    return { x: best, v: bestScore };
  };
  return (state, side = state.turn) => {
    if (state.phase === 'decks') return rules.suggestedDeclaration(state, side);
    const me = state.turn;
    const { x, v } = bestOf(state, me, true);
    // Spend the turn while anything is legal and not worse than passing.
    return x !== 0 && v >= score(state, me) ? x : rules.legalActions(state).at(-1) ?? 0;
  };
}
