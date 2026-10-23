import type { Ability, CardDef, Effect, Keyword, TargetSpec, Trigger, UnitState } from './types';

/**
 * The effect and keyword library, each entry defined once: validation, targeting, resolution and card text.
 * Adding an effect op means adding one entry to OPS (plus its type in types.ts); the rules engine, bot,
 * sim and client pick it up from here. Pure: resolution goes through the `Fx` the rules engine provides.
 */

// ---------------------------------------------------------------- targeting

/** Specs the acting player chooses a target for (the action's target bits). */
export const CHOSEN: readonly TargetSpec[] = ['enemy', 'enemy-unit', 'own-unit', 'any-unit'];
export const AUTOMATIC: readonly TargetSpec[] = ['self', 'enemy-champion', 'all-enemy-units', 'all-own-units', 'all-units', 'weakest-enemy', 'newest-own-unit', 'this'];
export const isChosen = (t: TargetSpec | null): boolean => t !== null && CHOSEN.includes(t);

/** A resolved target: a champion, or a unit on `side`'s board. */
export type Ref = { kind: 'champion'; side: 0 | 1 } | { kind: 'unit'; side: 0 | 1; unit: UnitState };

/** What effects may do to the match; the rules engine implements it. */
export interface Fx {
  /** Damage from a card (spell, ability, power or relic) of side `me`; `amount` already includes spellPower. */
  damage(ref: Ref, amount: number, sourceCard: number | null): void;
  heal(ref: Ref, amount: number): void;
  buff(unit: UnitState, attack: number, health: number): void;
  draw(side: 0 | 1, n: number): void;
  energy(side: 0 | 1, n: number): void;
  summon(side: 0 | 1, card: string, n: number): void;
}

interface OpDef {
  /** Problems with this effect's fields (other than `op` and `target`). */
  check(e: Effect, unitIds: ReadonlySet<string>): string[];
  /** The target spec when the effect omits one: `chosen` is whether a choice can be made in this context. */
  target(chosen: boolean): TargetSpec | null;
  /** Specs this op accepts. */
  allows: readonly TargetSpec[];
  apply(fx: Fx, e: Effect, me: 0 | 1, refs: Ref[], sourceCard: number | null, spellPower: number): void;
  /** Card text without the target phrase. */
  text(e: Effect, nameOf: (id: string) => string): string;
}

const int = (n: unknown, lo: number, hi: number): boolean => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const UNIT_SPECS: TargetSpec[] = ['own-unit', 'any-unit', 'enemy-unit', 'all-own-units', 'all-enemy-units', 'all-units', 'newest-own-unit', 'this'];

export const OPS: Record<Effect['op'], OpDef> = {
  damage: {
    check: (e) => (int((e as { amount: number }).amount, 1, 99) ? [] : ['damage needs an integer amount 1-99']),
    target: (chosen) => (chosen ? 'enemy' : 'enemy-champion'),
    allows: ['enemy', 'enemy-unit', 'any-unit', 'enemy-champion', 'all-enemy-units', 'all-units', 'weakest-enemy'],
    apply: (fx, e, _me, refs, src, sp) => { for (const r of refs) fx.damage(r, (e as { amount: number }).amount + sp, src); },
    text: (e) => `Deal ${(e as { amount: number }).amount}`,
  },
  heal: {
    check: (e) => (int((e as { amount: number }).amount, 1, 99) ? [] : ['heal needs an integer amount 1-99']),
    target: () => 'self',
    allows: ['self', 'own-unit', 'all-own-units', 'this'],
    apply: (fx, e, _me, refs) => { for (const r of refs) fx.heal(r, (e as { amount: number }).amount); },
    text: (e) => `Heal ${(e as { amount: number }).amount}`,
  },
  draw: {
    check: (e) => (int((e as { amount: number }).amount, 1, 9) ? [] : ['draw needs an integer amount 1-9']),
    target: () => null,
    allows: [],
    apply: (fx, e, me) => fx.draw(me, (e as { amount: number }).amount),
    text: (e) => `Draw ${(e as { amount: number }).amount}`,
  },
  energy: {
    check: (e) => (int((e as { amount: number }).amount, 1, 9) ? [] : ['energy needs an integer amount 1-9']),
    target: () => null,
    allows: [],
    apply: (fx, e, me) => fx.energy(me, (e as { amount: number }).amount),
    text: (e) => `+${(e as { amount: number }).amount} energy`,
  },
  buff: {
    check: (e) => {
      const b = e as { attack?: number; health?: number };
      return int(b.attack ?? 0, 0, 20) && int(b.health ?? 0, 0, 20) && (b.attack ?? 0) + (b.health ?? 0) > 0 ? [] : ['buff needs attack and/or health 1-20'];
    },
    target: (chosen) => (chosen ? 'own-unit' : 'newest-own-unit'),
    allows: UNIT_SPECS,
    apply: (fx, e, _me, refs) => { const b = e as { attack?: number; health?: number }; for (const r of refs) if (r.kind === 'unit') fx.buff(r.unit, b.attack ?? 0, b.health ?? 0); },
    text: (e) => { const b = e as { attack?: number; health?: number }; return `+${b.attack ?? 0}/+${b.health ?? 0}`; },
  },
  shield: {
    check: () => [],
    target: (chosen) => (chosen ? 'own-unit' : 'newest-own-unit'),
    allows: UNIT_SPECS,
    apply: (_fx, _e, _me, refs) => { for (const r of refs) if (r.kind === 'unit') r.unit.shield = true; },
    text: () => 'Shield',
  },
  summon: {
    check: (e, unitIds) => {
      const m = e as { card: string; count?: number };
      return [...(unitIds.has(m.card) ? [] : [`summon names ${JSON.stringify(m.card)}, which is not a unit card`]), ...(int(m.count ?? 1, 1, 5) ? [] : ['summon count must be 1-5'])];
    },
    target: () => null,
    allows: [],
    apply: (fx, e, me) => { const m = e as { card: string; count?: number }; fx.summon(me, m.card, m.count ?? 1); },
    text: (e, nameOf) => { const m = e as { card: string; count?: number }; return (m.count ?? 1) > 1 ? `Summon ${m.count} ${nameOf(m.card)}s` : `Summon ${nameOf(m.card)}`; },
  },
};

/** The spec an effect uses in a context where a choice can (`chosen`) or can't be made; null for untargeted ops. */
export function specOf(e: Effect, chosen: boolean): TargetSpec | null {
  const def = OPS[e.op];
  const t = 'target' in e && e.target ? e.target : def.target(chosen);
  return def.allows.length ? t : null;
}

/** Problems with one effect, `where` it is used: a choice is possible there unless `automatic`. */
export function checkEffect(e: Effect | undefined, unitIds: ReadonlySet<string>, opts: { automatic: boolean; onUnit: boolean }): string[] {
  if (!e || !(e.op in OPS)) return [`effect op must be one of ${Object.keys(OPS).join(', ')}`];
  const def = OPS[e.op];
  const errs = def.check(e, unitIds);
  const t = 'target' in e ? e.target : undefined;
  if (t !== undefined) {
    if (!def.allows.includes(t)) errs.push(`${e.op} can't target ${JSON.stringify(t)} (allowed: ${def.allows.join(', ') || 'none'})`);
    if (opts.automatic && isChosen(t)) errs.push(`target ${JSON.stringify(t)} needs a choice; here only automatic targets work (${AUTOMATIC.join(', ')})`);
    if (t === 'this' && !opts.onUnit) errs.push('target "this" only works in a unit\'s ability');
  }
  return errs;
}

// ---------------------------------------------------------------- keywords

export const KEYWORDS: Record<Keyword, string> = {
  guard: 'Enemies must attack it first',
  haste: 'Can attack the turn it is played',
  rush: 'Can attack units the turn it is played',
  lifesteal: 'Damage it deals heals your champion',
  shield: 'Blocks the first damage it would take',
  poison: 'Destroys any unit it damages',
  elusive: "Enemy spells and powers can't target it",
};

export const TRIGGERS: Record<Trigger, string> = { play: 'On play', death: 'Last words', turnStart: 'Each turn', attack: 'On attack' };

// ---------------------------------------------------------------- card text

const PHRASE: Record<TargetSpec, string> = {
  'enemy': '',
  'enemy-unit': ' to an enemy unit',
  'own-unit': ' to a friendly unit',
  'any-unit': ' to a unit',
  'self': '',
  'enemy-champion': ' to the enemy champion',
  'all-enemy-units': ' to all enemy units',
  'all-own-units': ' to your units',
  'all-units': ' to all units',
  'weakest-enemy': ' to the weakest enemy',
  'newest-own-unit': ' to your newest unit',
  'this': ' to itself',
};

/** One effect as card text, such as "Deal 2 to all enemy units". */
export function describeEffect(e: Effect, nameOf: (id: string) => string = (id) => id, chosen = true): string {
  const spec = specOf(e, chosen);
  // "Shield your units" reads better than "Shield to your units": the verb takes its target directly.
  if (e.op === 'shield' && spec) return `Shield${PHRASE[spec].replace(/^ to/, '')}`;
  return `${OPS[e.op].text(e, nameOf)}${spec ? PHRASE[spec] : ''}`;
}

export const describeAbility = (a: Ability, nameOf?: (id: string) => string): string => `${TRIGGERS[a.on]}: ${describeEffect(a.effect, nameOf, a.on === 'play')}`;

/** A card's rules text as lines: keywords, then abilities (units) or its effect (spells, relics). */
export function describeCard(def: CardDef, nameOf?: (id: string) => string): string[] {
  const lines: string[] = [];
  if (def.keywords?.length) lines.push(def.keywords.map((k) => k[0].toUpperCase() + k.slice(1)).join(' · '));
  for (const a of def.abilities ?? []) lines.push(describeAbility(a, nameOf));
  if (def.effect) lines.push(def.type === 'relic' ? `Each turn: ${describeEffect(def.effect, nameOf, false)}` : describeEffect(def.effect, nameOf, true));
  return lines;
}
