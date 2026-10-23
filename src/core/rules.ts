import { declare, declaredCard, decode, encode, endTurn, ENEMY_CHAMPION, enemyUnit, Op, OWN_CHAMPION, ownUnit, targetOf } from './actions';
import { normalizeStats } from './champion';
import { isChosen, OPS, specOf } from './effects';
import type { Fx, Ref } from './effects';
import type { CompiledGame } from './game';
import { seededRandom, shuffle } from './rng';
import type { AgentStats, CardDef, Effect, HeroPower, InitContext, Keyword, MatchState, PlayerState, StatMapping, StatName, TargetSpec, UnitState } from './types';

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
  /** The hero power a champion gets (by its card's element or kind, or its highest stat), or null. */
  heroPower(agent?: { stats?: AgentStats; tokenId?: string }): HeroPower | null;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Death triggers can chain; this many rounds per settle bounds the work one log entry can cause. */
const MAX_CHAIN = 16;
const STAT_ORDER: StatName[] = ['strength', 'agility', 'resilience', 'intelligence'];
/** FNV-1a over a 32-bit integer, 16 bits at a time: folds accepted actions into the draw entropy. */
const fold = (h: number, x: number): number => {
  h = Math.imul(h ^ (x & 0xffff), 0x01000193) >>> 0;
  return Math.imul(h ^ ((x >>> 16) & 0xffff), 0x01000193) >>> 0;
};

export function createRules(game: CompiledGame): Rules {
  const { config, cards, cardElement, beats, deckList, suggestedDeck, cardIndex, tokenCard } = game;
  const declared = config.deckRules?.mode === 'declared';
  const deckSize = config.deckRules?.size ?? 0;
  const maxCopies = config.deckRules?.maxCopies ?? 0;
  const R = config.rules;
  const maxTicks = config.litnode.maxTicks;
  const powers = config.champion.powers ?? [];

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
  /** Index of the first power whose conditions the champion meets; a player without a champion only meets unconditioned ones. */
  const powerIndex = (agent?: { stats?: AgentStats; tokenId?: string }): number => {
    const stats = normalizeStats(agent?.stats);
    const ci = agent?.tokenId != null ? tokenCard[String(agent.tokenId)] : undefined;
    const card = ci !== undefined ? cards[ci] : null;
    const hasStats = STAT_ORDER.some((k) => stats[k] > 0);
    const top = STAT_ORDER.reduce((best, k) => (stats[k] > stats[best] ? k : best), STAT_ORDER[0]);
    return powers.findIndex((pw) => (pw.element === undefined || card?.element === pw.element) && (pw.kind === undefined || card?.kind === pw.kind) && (pw.stat === undefined || (hasStats && top === pw.stat)));
  };

  const card = (c: number): CardDef => cards[c];
  const kw = (c: number, k: Keyword): boolean => cards[c].keywords?.includes(k) ?? false;
  const bonus = (attackerCard: number, defenderCard: number): number => (beats[cardElement[attackerCard]][cardElement[defenderCard]] ? R.elementBonus : 0);
  const foe = (me: 0 | 1): 0 | 1 => (me === 0 ? 1 : 0);

  /** One draw: a random card of the deck, from the seed, the turn's entropy and the match's draw count. */
  const draw = (s: MatchState, side: 0 | 1, n: number): void => {
    const p = s.p[side];
    for (let i = 0; i < n; i++) {
      if (!p.deck.length) {
        if (R.fatigue) { p.fatigue += 1; p.life -= p.fatigue; }
        continue;
      }
      const k = seededRandom(`${s.seed}|draw|${s.turnEnt}|${s.drawn}`)() % p.deck.length;
      s.drawn += 1;
      const c = p.deck.splice(k, 1)[0];
      if (p.hand.length < R.handLimit) p.hand.push(c); // a full hand burns the card
    }
  };

  const makeUnit = (s: MatchState, side: 0 | 1, c: number): UnitState => {
    const def = card(c);
    const hp = def.health ?? 1;
    return { c, atk: (def.attack ?? 0) + s.p[side].unitAttack, hp, max: hp, guard: kw(c, 'guard'), ready: kw(c, 'haste') || kw(c, 'rush'), fresh: true, shield: kw(c, 'shield') };
  };

  /**
   * Damage to a champion or unit. A unit's shield blocks the hit; element bonus applies to card-sourced damage on
   * units; poison (from a unit source) destroys a damaged unit; lifesteal heals the source's champion by what landed.
   */
  const hit = (s: MatchState, srcSide: 0 | 1, ref: Ref, amount: number, srcCard: number | null, srcUnit: UnitState | null): void => {
    if (amount <= 0) return;
    let dealt = 0;
    if (ref.kind === 'champion') { s.p[ref.side].life -= amount; dealt = amount; }
    else {
      const u = ref.unit;
      if (u.hp <= 0) return;
      if (u.shield) u.shield = false;
      else {
        dealt = amount + (srcCard !== null ? bonus(srcCard, u.c) : 0);
        u.hp -= dealt;
        if (srcUnit && kw(srcUnit.c, 'poison')) u.hp = Math.min(u.hp, 0);
      }
    }
    if (dealt > 0 && srcUnit && kw(srcUnit.c, 'lifesteal')) { const P = s.p[srcSide]; P.life = Math.min(P.life + dealt, P.maxLife); }
  };

  const fxFor = (s: MatchState, me: 0 | 1, srcUnit: UnitState | null): Fx => ({
    damage: (ref, amount, srcCard) => hit(s, me, ref, amount, srcCard, srcUnit),
    heal: (ref, amount) => {
      if (ref.kind === 'champion') { const P = s.p[ref.side]; P.life = Math.min(P.life + amount, P.maxLife); }
      else if (ref.unit.hp > 0) ref.unit.hp = Math.min(ref.unit.hp + amount, ref.unit.max);
    },
    buff: (u, attack, health) => { u.atk += attack; u.hp += health; u.max += health; },
    draw: (side, n) => draw(s, side, n),
    energy: (side, n) => { s.p[side].energy = Math.min(s.p[side].energy + n, 99); },
    summon: (side, id, n) => { const c = cardIndex[id]; for (let i = 0; i < n && s.p[side].board.length < R.boardSlots; i++) s.p[side].board.push(makeUnit(s, side, c)); },
  });

  // ---------------------------------------------------------- targets
  const unitRef = (s: MatchState, side: 0 | 1, slot: number): Ref | null => { const u = s.p[side].board[slot]; return u && u.hp > 0 ? { kind: 'unit', side, unit: u } : null; };
  /** The target the player chose (action target bits) for a chosen spec, or null if it isn't a legal choice. */
  const chosenRef = (s: MatchState, me: 0 | 1, spec: TargetSpec, t: number): Ref | null => {
    const tr = targetOf(t);
    const enemy = tr.side === 'enemy' && tr.kind === 'unit' ? unitRef(s, foe(me), tr.slot) : null;
    const enemyOk = enemy && enemy.kind === 'unit' && !kw(enemy.unit.c, 'elusive') ? enemy : null;
    const own = tr.side === 'own' && tr.kind === 'unit' ? unitRef(s, me, tr.slot) : null;
    switch (spec) {
      case 'enemy': return tr.side === 'enemy' && tr.kind === 'champion' ? { kind: 'champion', side: foe(me) } : enemyOk;
      case 'enemy-unit': return enemyOk;
      case 'own-unit': return own;
      case 'any-unit': return enemyOk ?? own;
      default: return null;
    }
  };
  const autoRefs = (s: MatchState, me: 0 | 1, spec: TargetSpec, self: UnitState | null): Ref[] => {
    const units = (side: 0 | 1): Ref[] => s.p[side].board.filter((u) => u.hp > 0).map((unit) => ({ kind: 'unit', side, unit }));
    switch (spec) {
      case 'self': return [{ kind: 'champion', side: me }];
      case 'enemy-champion': return [{ kind: 'champion', side: foe(me) }];
      case 'all-enemy-units': return units(foe(me));
      case 'all-own-units': return units(me);
      case 'all-units': return [...units(me), ...units(foe(me))];
      case 'weakest-enemy': {
        const es = units(foe(me));
        return es.length ? [es.reduce((a, b) => ((b as { unit: UnitState }).unit.hp < (a as { unit: UnitState }).unit.hp ? b : a))] : [{ kind: 'champion', side: foe(me) }];
      }
      case 'newest-own-unit': { const us = units(me); return us.length ? [us[us.length - 1]] : []; }
      case 'this': return self && self.hp > 0 ? [{ kind: 'unit', side: me, unit: self }] : [];
      default: return [];
    }
  };

  /**
   * Validate (check) or apply one effect for side `me`. In a chosen context the action's target `t` must be a legal
   * choice for a chosen spec, and 0 otherwise (one encoding per action). Automatic contexts ignore `t`.
   */
  const resolveEffect = (s: MatchState, me: 0 | 1, e: Effect, t: number, chosen: boolean, check: boolean, src: { card: number | null; unit: UnitState | null; spellPower: number }): boolean => {
    const spec = specOf(e, chosen);
    let refs: Ref[] = [];
    if (spec && isChosen(spec)) {
      const r = chosenRef(s, me, spec, t);
      if (!r) return false;
      refs = [r];
    } else {
      if (chosen && t !== 0) return false;
      if (spec) refs = autoRefs(s, me, spec, src.unit);
    }
    if (check) return true;
    OPS[e.op].apply(fxFor(s, me, src.unit), e, me, refs, src.card, e.op === 'damage' ? src.spellPower : 0);
    return true;
  };
  /** Whether a chosen-target effect has any legal target right now. */
  const anyTarget = (s: MatchState, me: 0 | 1, e: Effect): boolean => {
    const spec = specOf(e, true);
    if (!spec || !isChosen(spec)) return true;
    const codes = [ENEMY_CHAMPION, ...s.p[foe(me)].board.map((_, i) => enemyUnit(i)), ...s.p[me].board.map((_, i) => ownUnit(i))];
    return codes.some((t) => chosenRef(s, me, spec, t) !== null);
  };

  /** Remove dead units (firing their `death` abilities, which may chain), then end the match if a champion fell. */
  const settle = (s: MatchState): void => {
    for (let round = 0; round < MAX_CHAIN; round++) {
      const dead: Array<{ side: 0 | 1; unit: UnitState }> = [];
      for (const side of [s.turn, foe(s.turn)]) for (const unit of s.p[side].board) if (unit.hp <= 0) dead.push({ side, unit });
      if (!dead.length) break;
      for (const p of s.p) p.board = p.board.filter((u) => u.hp > 0);
      for (const d of dead) for (const a of card(d.unit.c).abilities ?? []) if (a.on === 'death') resolveEffect(s, d.side, a.effect, 0, false, false, { card: d.unit.c, unit: d.unit, spellPower: 0 });
    }
    for (const p of s.p) p.board = p.board.filter((u) => u.hp > 0);
    const dead0 = s.p[0].life <= 0, dead1 = s.p[1].life <= 0;
    if ((dead0 || dead1) && !s.over) { s.over = true; s.winner = dead0 && dead1 ? 2 : dead0 ? 1 : 0; }
  };

  const fire = (s: MatchState, me: 0 | 1, u: UnitState, on: 'turnStart' | 'attack'): void => {
    for (const a of card(u.c).abilities ?? []) if (a.on === on && u.hp > 0) resolveEffect(s, me, a.effect, 0, false, false, { card: u.c, unit: u, spellPower: 0 });
  };

  const startTurn = (s: MatchState): void => {
    const me = s.turn;
    const P = s.p[me];
    s.turnEnt = s.ent;
    P.energyCap = Math.min(R.energyMax, P.energyCap + R.energyPerTurn);
    P.energy = P.energyCap + (s.turnNo === 2 ? R.secondPlayerEnergy : 0);
    P.powerUsed = false;
    for (const u of P.board) { u.ready = true; u.fresh = false; }
    if (s.turnNo > 1) draw(s, me, 1);
    // Relics fire at their owner's turn start (automatic targets), then units' turn-start abilities, left to right.
    for (const r of P.relics) { const e = card(r).effect; if (e) resolveEffect(s, me, e, 0, false, false, { card: r, unit: null, spellPower: P.spellPower }); }
    for (const u of [...P.board]) fire(s, me, u, 'turnStart');
    settle(s);
  };

  /** Validate (check=true) or apply (check=false) one action for the player to act. */
  const act = (s: MatchState, x: number, check: boolean): boolean => {
    const me = s.turn;
    const P = s.p[me], E = s.p[foe(me)];
    const { op, a, target } = decode(x);
    if (op === Op.End) {
      if (a !== 0 || target !== 0) return false;
      if (check) return true;
      s.turn = foe(me);
      s.turnNo += 1;
      startTurn(s);
      return true;
    }
    if (op === Op.Power) {
      const pw = P.power >= 0 ? powers[P.power] : null;
      if (!pw || a !== 0 || P.powerUsed || pw.cost > P.energy) return false;
      const src = { card: null, unit: null, spellPower: 0 };
      if (!resolveEffect(s, me, pw.effect, target, true, true, src)) return false;
      if (check) return true;
      P.energy -= pw.cost;
      P.powerUsed = true;
      resolveEffect(s, me, pw.effect, target, true, false, src);
      settle(s);
      return true;
    }
    if (op === Op.Play) {
      const c = P.hand[a];
      if (c === undefined) return false;
      const def = card(c);
      if (def.cost > P.energy) return false;
      if (def.type === 'unit') {
        if (P.board.length >= R.boardSlots) return false;
        // A play ability with a chosen target takes the action's target; with nothing to choose it fizzles (target 0).
        const onPlay = (def.abilities ?? []).filter((ab) => ab.on === 'play');
        const aim = onPlay.find((ab) => isChosen(specOf(ab.effect, true)));
        const fizzle = aim ? !anyTarget(s, me, aim.effect) : false;
        if (aim && !fizzle) { if (!resolveEffect(s, me, aim.effect, target, true, true, { card: c, unit: null, spellPower: 0 })) return false; }
        else if (target !== 0) return false;
        if (check) return true;
        P.hand.splice(a, 1);
        P.energy -= def.cost;
        const u = makeUnit(s, me, c);
        P.board.push(u);
        for (const ab of onPlay) {
          const chosen = isChosen(specOf(ab.effect, true));
          if (chosen && fizzle) continue;
          resolveEffect(s, me, ab.effect, chosen ? target : 0, chosen, false, { card: c, unit: u, spellPower: 0 });
        }
        settle(s);
        return true;
      }
      if (def.type === 'relic') {
        if (P.relics.length >= R.relicSlots || target !== 0) return false;
        if (check) return true;
        P.hand.splice(a, 1);
        P.energy -= def.cost;
        P.relics.push(c);
        return true;
      }
      const src = { card: c, unit: null, spellPower: P.spellPower };
      if (!def.effect || !resolveEffect(s, me, def.effect, target, true, true, src)) return false;
      if (check) return true;
      P.hand.splice(a, 1);
      P.energy -= def.cost;
      resolveEffect(s, me, def.effect, target, true, false, src);
      settle(s);
      return true;
    }
    if (op === Op.Attack) {
      const u = P.board[a];
      if (!u || !u.ready || u.atk <= 0) return false;
      const tr = targetOf(target);
      if (tr.side !== 'enemy') return false;
      const guarded = E.board.some((g) => g.guard);
      const d = tr.kind === 'unit' ? E.board[tr.slot] : null;
      if (tr.kind === 'champion') {
        // Rush lets a unit attack units the turn it lands; only haste reaches the champion that turn.
        if (guarded || (u.fresh && !kw(u.c, 'haste'))) return false;
      } else if (!d || (guarded && !d.guard)) return false;
      if (check) return true;
      u.ready = false;
      fire(s, me, u, 'attack');
      if (u.hp > 0) {
        if (!d) hit(s, me, { kind: 'champion', side: foe(me) }, u.atk, null, u);
        else if (d.hp > 0) {
          const back = d.atk;
          hit(s, me, { kind: 'unit', side: foe(me), unit: d }, u.atk, u.c, u);
          hit(s, foe(me), { kind: 'unit', side: me, unit: u }, back, d.c, d);
        }
      }
      settle(s);
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
    const P = s.p[s.turn], E = s.p[foe(s.turn)];
    const out: number[] = [];
    const codes = [ENEMY_CHAMPION, ...E.board.map((_, i) => enemyUnit(i)), OWN_CHAMPION, ...P.board.map((_, i) => ownUnit(i))];
    const tryAll = (mk: (t: number) => number): void => { for (const t of codes) { const x = mk(t); if (act(s, x, true)) out.push(x); } };
    P.hand.forEach((_, i) => tryAll((t) => encode(Op.Play, i, t)));
    P.board.forEach((_, i) => { for (const t of [ENEMY_CHAMPION, ...E.board.map((__, j) => enemyUnit(j))]) { const x = encode(Op.Attack, i, t); if (act(s, x, true)) out.push(x); } });
    tryAll((t) => encode(Op.Power, 0, t));
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
      draw(s, i, s.opening![i]);
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
    heroPower: (agent) => { const i = powerIndex(agent); return i >= 0 ? powers[i] : null; },
    suggestedDeclaration,
    init(seed, participants, ctx = {}) {
      const rnd = seededRandom(String(seed));
      const ids = [String(participants[0]), String(participants[1])];
      const players = ids.map((id): PlayerState => {
        const agent = ctx.agents?.[id];
        const ch = champion(agent?.stats);
        return { id, life: ch.life, maxLife: ch.life, energy: 0, energyCap: R.energyStart - R.energyPerTurn, spellPower: ch.spellPower, unitAttack: ch.unitAttack, deck: declared ? [] : shuffle(deckList.slice(), rnd), hand: [], board: [], relics: [], fatigue: 0, power: powerIndex(agent), powerUsed: false };
      }) as [PlayerState, PlayerState];
      const first = (rnd() & 1) as 0 | 1;
      const opening = ids.map((id) => champion(ctx.agents?.[id]?.stats).openingHand) as [number, number];
      opening[foe(first)] += R.secondPlayerCards ?? 0;
      const s: MatchState = { v: 2, beat: 0, turn: first, turnNo: 1, over: false, winner: -1, p: players, last: 0, seed: String(seed), ent: 0, turnEnt: 0, drawn: 0 };
      if (declared) {
        // Decks come from the log: both sides declare before turn 1, then finishDecks shuffles and deals.
        Object.assign(s, { phase: 'decks', decl: [[], []], opening });
        return s;
      }
      ids.forEach((_, i) => draw(s, i as 0 | 1, opening[i]));
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
        if (s.last) s.ent = fold(fold(s.ent, frame(0)), frame(1));
        if (s.decl![0].length === deckSize && s.decl![1].length === deckSize) finishDecks(s);
        finishOnCap(s);
        return s;
      }
      const x = frame(s.turn);
      s.last = 0;
      if (x !== 0 && act(s, x, true)) {
        // Fold before acting, so an END's new turn draws from entropy that includes the END itself.
        s.ent = fold(s.ent, x);
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
