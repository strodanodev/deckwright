import { declare, declaredCard, decode, encode, endTurn, ENEMY_CHAMPION, enemyUnit, Op, OWN_CHAMPION, ownUnit, targetOf } from './actions';
import type { CompiledGame } from './game';
import { normalizeStats } from './champion';
import { seededRandom, shuffle } from './rng';
import type { AgentStats, CardDef, InitContext, MatchState, PlayerState, StatMapping, UnitState } from './types';

/** The client-visible projection: deck order is replaced by a count. */
export type MatchView = Omit<MatchState, 'p'> & { p: Array<Omit<PlayerState, 'deck'> & { deck: number }> };

export interface Rules {
  game: CompiledGame;
  init(seed: string, participants: string[], ctx?: InitContext): MatchState;
  /** One log entry. `inputs` is `{ [playerId]: frame }`; only the acting player's frame is read. */
  step(state: MatchState, inputs: Record<string, number>): MatchState;
  done(state: MatchState): boolean;
  scores(state: MatchState): Record<string, number>;
  serialize(state: MatchState): MatchState;
  view(state: MatchState): MatchView;
  /** Every legal action for the player to act, END last. In the deck phase: the declarations still open to that side. */
  legalActions(state: MatchState, side?: 0 | 1): number[];
  /** Legal for the player to act (play phase), or for `side` (deck phase; defaults to the player to act). */
  isLegal(state: MatchState, action: number, side?: 0 | 1): boolean;
  /** Declared-deck games: the side's next declaration from the suggested deck (bots, relay fallback), or 0 when done. */
  suggestedDeclaration(state: MatchState, side: 0 | 1): number;
  /** The champion numbers a player gets from their ERC-6699 stats (normalized; none or missing = 0). */
  champion(stats?: AgentStats): { life: number; spellPower: number; unitAttack: number; openingHand: number };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createRules(game: CompiledGame): Rules {
  const { config, cards, cardElement, beats, deckList, suggestedDeck } = game;
  const declared = config.deckRules?.mode === 'declared';
  const deckSize = config.deckRules?.size ?? 0;
  const maxCopies = config.deckRules?.maxCopies ?? 0;
  const R = config.rules;
  const maxTicks = config.litnode.maxTicks;

  // Stats go through normalizeStats first, so a missing champion or stat is 0, exactly as LitNode hydrates it.
  const mapStat = (m: StatMapping, stats: Required<AgentStats>): number => Math.round(m.min + ((m.max - m.min) * stats[m.stat]) / 65535);
  const champion = (raw?: AgentStats): ReturnType<Rules['champion']> => {
    const stats = normalizeStats(raw);
    return {
      life: mapStat(config.champion.life, stats),
      spellPower: mapStat(config.champion.spellPower, stats),
      unitAttack: mapStat(config.champion.unitAttack, stats),
      openingHand: mapStat(config.champion.openingHand, stats),
    };
  };

  const card = (c: number): CardDef => cards[c];
  const bonus = (attackerCard: number, defenderCard: number): number => (beats[cardElement[attackerCard]][cardElement[defenderCard]] ? R.elementBonus : 0);

  const draw = (p: PlayerState, n: number): void => {
    for (let i = 0; i < n; i++) {
      const c = p.deck.pop();
      if (c === undefined) {
        if (R.fatigue) { p.fatigue += 1; p.life -= p.fatigue; }
        continue;
      }
      if (p.hand.length < R.handLimit) p.hand.push(c); // a full hand burns the card
    }
  };

  const settleDeaths = (s: MatchState): void => {
    for (const p of s.p) p.board = p.board.filter((u) => u.hp > 0);
    const dead0 = s.p[0].life <= 0, dead1 = s.p[1].life <= 0;
    if (dead0 || dead1) { s.over = true; s.winner = dead0 && dead1 ? 2 : dead0 ? 1 : 0; }
  };

  /** Spell or relic effect from `me` (index) against target code `t`. Returns false if the target is invalid. */
  const resolve = (s: MatchState, me: 0 | 1, c: number, t: number, check: boolean): boolean => {
    const e = card(c).effect;
    if (!e) return false;
    const P = s.p[me], E = s.p[me === 0 ? 1 : 0];
    const tr = targetOf(t);
    switch (e.op) {
      case 'damage': {
        if (tr.side !== 'enemy') return false;
        if (tr.kind === 'unit' && !E.board[tr.slot]) return false;
        if (check) return true;
        const amount = e.amount + P.spellPower;
        if (tr.kind === 'champion') E.life -= amount;
        else { const u = E.board[tr.slot]; u.hp -= amount + bonus(c, u.c); }
        return true;
      }
      case 'heal':
        if (!check) P.life = Math.min(P.life + e.amount, P.maxLife);
        return true;
      case 'draw':
        if (!check) draw(P, e.amount);
        return true;
      case 'energy':
        if (!check) P.energy = Math.min(P.energy + e.amount, 99);
        return true;
      case 'buff': {
        if (tr.side !== 'own' || tr.kind !== 'unit' || !P.board[tr.slot]) return false;
        if (!check) { const u = P.board[tr.slot]; u.atk += e.attack ?? 0; u.hp += e.health ?? 0; }
        return true;
      }
    }
    return false;
  };

  const startTurn = (s: MatchState): void => {
    const me = s.turn;
    const P = s.p[me];
    P.energyCap = Math.min(R.energyMax, P.energyCap + R.energyPerTurn);
    P.energy = P.energyCap + (s.turnNo === 2 ? R.secondPlayerEnergy : 0);
    for (const u of P.board) u.ready = true;
    if (s.turnNo > 1) draw(P, 1);
    // Relics fire at their owner's turn start. Damage relics hit the enemy champion; buff relics the newest unit.
    for (const r of P.relics) {
      const e = card(r).effect;
      const t = e?.op === 'buff' ? (P.board.length ? ownUnit(P.board.length - 1) : -1) : e?.op === 'damage' ? ENEMY_CHAMPION : OWN_CHAMPION;
      if (t >= 0) resolve(s, me, r, t, false);
    }
    settleDeaths(s);
  };

  /** Validate (check=true) or apply (check=false) one action for the player to act. */
  const act = (s: MatchState, x: number, check: boolean): boolean => {
    const me = s.turn;
    const P = s.p[me], E = s.p[me === 0 ? 1 : 0];
    const { op, a, target } = decode(x);
    if (op === Op.End) {
      if (check) return true;
      s.turn = me === 0 ? 1 : 0;
      s.turnNo += 1;
      startTurn(s);
      return true;
    }
    if (op === Op.Play) {
      const c = P.hand[a];
      if (c === undefined) return false;
      const def = card(c);
      if (def.cost > P.energy) return false;
      if (def.type === 'unit') {
        if (P.board.length >= R.boardSlots) return false;
        if (check) return true;
        const kw = def.keywords ?? [];
        const u: UnitState = { c, atk: (def.attack ?? 0) + P.unitAttack, hp: def.health ?? 1, guard: kw.includes('guard'), ready: kw.includes('haste') };
        P.board.push(u);
      } else if (def.type === 'relic') {
        if (P.relics.length >= R.relicSlots) return false;
        if (check) return true;
        P.relics.push(c);
      } else {
        if (!resolve(s, me, c, target, true)) return false;
        if (check) return true;
        P.hand.splice(a, 1);
        P.energy -= def.cost;
        resolve(s, me, c, target, false);
        settleDeaths(s);
        return true;
      }
      P.hand.splice(a, 1);
      P.energy -= def.cost;
      return true;
    }
    if (op === Op.Attack) {
      const u = P.board[a];
      if (!u || !u.ready || u.atk <= 0) return false;
      const tr = targetOf(target);
      if (tr.side !== 'enemy') return false;
      const guarded = E.board.some((g) => g.guard);
      if (tr.kind === 'champion') {
        if (guarded) return false;
        if (check) return true;
        E.life -= u.atk;
      } else {
        const d = E.board[tr.slot];
        if (!d || (guarded && !d.guard)) return false;
        if (check) return true;
        d.hp -= u.atk + bonus(u.c, d.c);
        u.hp -= d.atk + bonus(d.c, u.c);
      }
      u.ready = false;
      settleDeaths(s);
      return true;
    }
    return false;
  };

  const finishOnCap = (s: MatchState): void => {
    if (s.over || s.beat < maxTicks) return;
    s.over = true;
    const l0 = s.p[0].life, l1 = s.p[1].life;
    s.winner = l0 === l1 ? 2 : l0 > l1 ? 0 : 1;
  };

  const legalActions = (s: MatchState): number[] => {
    if (s.over) return [];
    const P = s.p[s.turn], E = s.p[s.turn === 0 ? 1 : 0];
    const out: number[] = [];
    const targets: number[] = [ENEMY_CHAMPION, ...E.board.map((_, i) => enemyUnit(i)), OWN_CHAMPION, ...P.board.map((_, i) => ownUnit(i))];
    P.hand.forEach((c, i) => {
      const def = card(c);
      if (def.type === 'spell') {
        // Only list targets the effect uses, so bots and UIs do not see duplicates.
        const op = def.effect?.op;
        const ts = op === 'damage' || op === 'buff' ? targets : [OWN_CHAMPION];
        for (const t of ts) { const x = encode(Op.Play, i, t); if (act(s, x, true)) out.push(x); }
      } else {
        const x = encode(Op.Play, i, 0);
        if (act(s, x, true)) out.push(x);
      }
    });
    P.board.forEach((_, i) => {
      for (const t of [ENEMY_CHAMPION, ...E.board.map((__, j) => enemyUnit(j))]) { const x = encode(Op.Attack, i, t); if (act(s, x, true)) out.push(x); }
    });
    out.push(endTurn());
    return out;
  };

  // ---------------------------------------------------------- declared decks
  const canDeclare = (s: MatchState, side: 0 | 1, x: number): boolean => {
    if (s.phase !== 'decks' || decode(x).op !== Op.Declare) return false;
    const c = declaredCard(x);
    const mine = s.decl![side];
    return c < cards.length && mine.length < deckSize && mine.filter((d) => d === c).length < maxCopies;
  };
  /** Both decks declared: shuffle each from the match seed, draw opening hands, start turn 1. */
  const finishDecks = (s: MatchState): void => {
    for (const i of [0, 1] as const) {
      s.p[i].deck = shuffle(s.decl![i].slice(), seededRandom(`${s.seed}|deck|${i}`));
      draw(s.p[i], s.opening![i]);
    }
    s.phase = 'play';
    startTurn(s);
  };
  const suggestedDeclaration = (s: MatchState, side: 0 | 1): number => {
    if (s.phase !== 'decks') return 0;
    const mine = s.decl![side];
    for (const c of suggestedDeck) {
      const x = declare(c);
      if (mine.filter((d) => d === c).length < suggestedDeck.filter((d) => d === c).length && canDeclare(s, side, x)) return x;
    }
    // The player's own picks used up the suggestion's copies: any legal card from the default deck, then any card.
    for (const c of deckList) if (canDeclare(s, side, declare(c))) return declare(c);
    for (let c = 0; c < cards.length; c++) if (canDeclare(s, side, declare(c))) return declare(c);
    return 0;
  };

  return {
    game,
    champion,
    suggestedDeclaration,
    init(seed, participants, ctx = {}) {
      const rnd = seededRandom(String(seed));
      const ids = [String(participants[0]), String(participants[1])];
      const players = ids.map((id): PlayerState => {
        const ch = champion(ctx.agents?.[id]?.stats);
        return { id, life: ch.life, maxLife: ch.life, energy: 0, energyCap: R.energyStart - R.energyPerTurn, spellPower: ch.spellPower, unitAttack: ch.unitAttack, deck: declared ? [] : shuffle(deckList.slice(), rnd), hand: [], board: [], relics: [], fatigue: 0 };
      }) as [PlayerState, PlayerState];
      const first = (rnd() & 1) as 0 | 1;
      const opening = ids.map((id) => champion(ctx.agents?.[id]?.stats).openingHand) as [number, number];
      opening[first === 0 ? 1 : 0] += R.secondPlayerCards ?? 0;
      const s: MatchState = { v: 1, beat: 0, turn: first, turnNo: 1, over: false, winner: -1, p: players, last: 0 };
      if (declared) {
        // Decks come from the log: both sides declare before turn 1, then finishDecks shuffles and deals.
        Object.assign(s, { phase: 'decks', decl: [[], []], seed: String(seed), opening });
        return s;
      }
      ids.forEach((_, i) => draw(players[i], opening[i]));
      startTurn(s);
      return s;
    },
    step(state, inputs) {
      if (state.over) return state;
      const s = clone(state);
      s.beat += 1;
      const frame = (i: 0 | 1): number => { const raw = inputs?.[s.p[i].id]; return typeof raw === 'number' ? raw | 0 : 0; };
      const quit0 = decode(frame(0)).op === Op.Concede, quit1 = decode(frame(1)).op === Op.Concede;
      if (quit0 || quit1) {
        s.over = true;
        s.winner = quit0 && quit1 ? 2 : quit0 ? 1 : 0;
        s.last = quit0 ? frame(0) : frame(1);
        return s;
      }
      if (s.phase === 'decks') {
        // Both sides may declare in the same entry; an illegal declaration is a no-op like any other action.
        s.last = 0;
        for (const i of [0, 1] as const) {
          const d = frame(i);
          if (canDeclare(s, i, d)) { s.decl![i].push(declaredCard(d)); s.last = d; }
        }
        if (s.decl![0].length === deckSize && s.decl![1].length === deckSize) finishDecks(s);
        finishOnCap(s);
        return s;
      }
      const x = frame(s.turn);
      s.last = 0;
      if (x !== 0 && act(s, x, true)) {
        act(s, x, false);
        s.last = x;
      }
      finishOnCap(s);
      return s;
    },
    done: (s) => s.over === true,
    scores(s) {
      const [a, b] = [s.p[0].id, s.p[1].id];
      if (s.winner === 0) return { [a]: 1, [b]: 0 };
      if (s.winner === 1) return { [a]: 0, [b]: 1 };
      return { [a]: 0, [b]: 0 };
    },
    serialize: (s) => s,
    view: (s) => ({ ...s, p: s.p.map((pl) => ({ ...pl, deck: pl.deck.length })) }),
    legalActions: (s, side) => {
      if (s.phase !== 'decks') return legalActions(s);
      const me = side ?? s.turn;
      return cards.map((_, c) => declare(c)).filter((x) => canDeclare(s, me, x));
    },
    isLegal: (s, x, side) => !s.over && (s.phase === 'decks' ? canDeclare(s, side ?? s.turn, x) : (side === undefined || side === s.turn) && act(clone(s), x, true)),
  };
}
