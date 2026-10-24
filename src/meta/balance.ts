/**
 * The balance harness: greedy bots play N matches with seeded randomness, every log is replayed from scratch and
 * must reach the same state, and the result is a report of balance numbers and fun targets. Pure and
 * browser-safe, so the CLI (`tessaract sim`) and Tessaract Studio run the same harness and get the same numbers
 * for the same seeds. Kernel-compatible: only the telemetry (attacks, plays, board) is card-game specific.
 */
import { declare, decode, Op } from '../core/actions';
import { greedyBot } from '../core/bot';
import { normalizeStats } from '../core/champion';
import { compileGame } from '../core/game';
import { seededRandom } from '../core/rng';
import { createRules } from '../core/rules';
import type { AgentStats, GameConfig, MatchState } from '../core/types';

export type DeckMode = 'suggested' | 'random' | 'mixed';
export type StatsMode = 'random' | 'base';

export interface SimOptions {
  matches?: number;
  /** Declared-deck games: the suggested deck, random legal decks, or alternating. */
  decks?: DeckMode;
  /** Random ERC-6699 champions (the default with a collection) or none (the default without one). */
  stats?: StatsMode;
  /** The seed of match `m`. The CLI uses LitNode-style hashes; anything deterministic works. */
  seedOf?: (m: number) => string;
  /** Called after each match, for progress bars. */
  onProgress?: (done: number, total: number) => void;
}

export interface FunTarget { name: string; value: string; ok: boolean | null; want: string }

export interface SimReport {
  title: string;
  rulesetId: string;
  matches: number;
  decks: DeckMode | 'fixed';
  stats: StatsMode;
  firstWins: number;
  secondWins: number;
  draws: number;
  capped: number;
  maxTicks: number;
  avgEntries: number;
  avgTurns: number;
  mismatches: number;
  neverPlayed: string[];
  /** Random or mixed decks only: cards by the win rate of decks holding them (at least 20 decks). */
  strongest: Array<{ id: string; rate: number }>;
  weakest: Array<{ id: string; rate: number }>;
  targets: FunTarget[];
  powersPerMatch: number;
  powerRates: Array<{ name: string; rate: number }>;
  /** Fun targets missed (first-player band included). */
  missed: number;
}

export function simulate(game: GameConfig, opts: SimOptions = {}): SimReport {
  const matches = opts.matches ?? 200;
  const declared = game.deckRules?.mode === 'declared';
  const decks: DeckMode = declared ? opts.decks ?? 'suggested' : 'suggested';
  const statsMode: StatsMode = opts.stats ?? (game.cards.some((c) => c.token) ? 'random' : 'base');
  const seedOf = opts.seedOf ?? ((m: number) => `sim-${m}`);
  const rules = createRules(compileGame(game));
  const bot = greedyBot(rules);
  const players = ['a'.repeat(64), 'b'.repeat(64)];
  const rnd = seededRandom('tcg-sim');
  const randomStats = (): AgentStats => (statsMode === 'base' ? normalizeStats(null) : { strength: rnd() % 65536, agility: rnd() % 65536, resilience: rnd() % 65536, intelligence: rnd() % 65536 });
  /** A random legal deck: deckRules.size cards drawn from the whole card list, at most maxCopies of each. */
  const randomDeck = (): number[] => {
    const { size, maxCopies } = game.deckRules!;
    const pool = game.cards.flatMap((_, c) => Array.from({ length: maxCopies }, () => c));
    for (let i = pool.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, size);
  };

  let firstWins = 0, secondWins = 0, draws = 0, capped = 0, beats = 0, turns = 0, mismatches = 0;
  // Fun telemetry: what attacks hit, what gets played, whether the board decides games, how much champions decide them.
  let faceAttacks = 0, unitAttacks = 0, unitPlays = 0, otherPlays = 0, powers = 0, close = 0, boardLed = 0, boardLedWon = 0, edged = 0, edgedWon = 0;
  const lengths: number[] = [];
  // Per hero power: sides that had it, and how many of those won (only matches between different powers count).
  const byPower = new Map<number, { n: number; won: number }>();
  const played = new Map<number, number>();
  // Per card: matches it was in a side's deck, and how many of those that side won.
  const inDeck = new Map<number, { n: number; won: number }>();
  const tokenCards = game.cards.filter((c) => c.token);

  for (let m = 0; m < matches; m++) {
    const seed = seedOf(m);
    // A random champion card from the game's collection (for element powers), with random stats.
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
    opts.onProgress?.(m + 1, matches);
  }

  const pct = (n: number, of = matches): string => `${((100 * n) / of).toFixed(1)}%`;
  // With random decks every card shows up in many decks, so its deck win rate says something about its strength.
  const rated = decks === 'suggested' ? [] : [...inDeck.entries()].filter(([, e]) => e.n >= 20).map(([c, e]) => ({ id: game.cards[c].id, rate: e.won / e.n })).sort((a, b) => b.rate - a.rate);
  // Fun targets. They are measured with the house bot, so read them as signals about the card set, not about people.
  const mean = lengths.reduce((a, b) => a + b, 0) / matches;
  const spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / matches);
  const share = (a: number, b: number): number => (b ? a / b : 0);
  const targets: FunTarget[] = [
    { name: 'first player wins', value: pct(firstWins), ok: firstWins / matches >= 0.45 && firstWins / matches <= 0.55, want: '45-55%' },
    { name: 'attacks at the champion', value: `${(100 * share(faceAttacks, faceAttacks + unitAttacks)).toFixed(0)}%`, ok: share(faceAttacks, faceAttacks + unitAttacks) <= 0.85, want: 'at most 85%: units should fight units' },
    { name: 'spells, relics, powers', value: `${(100 * share(otherPlays + powers, unitPlays + otherPlays + powers)).toFixed(0)}% of plays`, ok: share(otherPlays + powers, unitPlays + otherPlays + powers) >= 0.15, want: 'at least 15%' },
    { name: 'board leader wins', value: boardLed >= 20 ? `${(100 * share(boardLedWon, boardLed)).toFixed(0)}%` : 'n/a', ok: boardLed >= 20 ? share(boardLedWon, boardLed) >= 0.5 : null, want: 'at least 50% (after 6 turns each)' },
    { name: 'champion edge wins', value: edged >= 20 ? `${(100 * share(edgedWon, edged)).toFixed(0)}%` : 'n/a', ok: edged >= 20 ? share(edgedWon, edged) <= 0.62 : null, want: 'at most 62% (4+ more starting life)' },
    { name: 'close finishes', value: pct(close), ok: close / matches >= 0.15, want: 'at least 15% (winner on 5 life or less)' },
    { name: 'match length spread', value: `±${spread.toFixed(1)} turns`, ok: spread >= 2, want: 'at least ±2 turns' },
  ];
  const list = game.champion.powers ?? [];
  return {
    title: game.title,
    rulesetId: game.litnode.rulesetId,
    matches,
    decks: declared ? decks : 'fixed',
    stats: statsMode,
    firstWins, secondWins, draws, capped,
    maxTicks: game.litnode.maxTicks,
    avgEntries: beats / matches,
    avgTurns: turns / matches,
    mismatches,
    neverPlayed: game.cards.filter((_, c) => !played.has(c)).map((c) => c.id),
    strongest: rated.length >= 6 ? rated.slice(0, 5) : [],
    weakest: rated.length >= 6 ? rated.slice(-5).reverse() : [],
    targets,
    powersPerMatch: powers / matches,
    powerRates: [...byPower.entries()].filter(([, e]) => e.n >= 20).map(([i, e]) => ({ name: i >= 0 ? list[i].name : 'none', rate: e.won / e.n })),
    missed: targets.filter((t) => t.ok === false).length,
  };
}
