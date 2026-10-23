import type { CardDef, GameConfig, StatMapping } from './types';

/** A validated config with cards indexed for the rules engine. */
export interface CompiledGame {
  config: GameConfig;
  cards: CardDef[];
  /** Element index per card, parallel to `cards`. */
  cardElement: number[];
  /** `beats[a][b]`: element a deals bonus damage to element b. */
  beats: boolean[][];
  /** The deck as card indices, before shuffling. */
  deckList: number[];
  cardIndex: Record<string, number>;
}

const RULESET_ID = /^[a-z0-9][a-z0-9-]*\.v\d+$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]*$/;
const STATS = ['strength', 'agility', 'resilience', 'intelligence'];
const isInt = (n: unknown, lo: number, hi: number): boolean => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;

/** Every problem with a game config, or an empty list. Runs at build time and in the client. */
export function validateGame(cfg: GameConfig): string[] {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string): void => { if (!ok) errs.push(msg); };

  need(typeof cfg.title === 'string' && cfg.title.length > 0, 'title is required');
  const ln = cfg.litnode ?? ({} as GameConfig['litnode']);
  need(RULESET_ID.test(ln.rulesetId ?? ''), `litnode.rulesetId must look like "my-game.v1" (got ${JSON.stringify(ln.rulesetId)})`);
  need(isInt(ln.tickRate, 1, 120), 'litnode.tickRate must be an integer 1-120');
  need(isInt(ln.maxTicks, 20, 5000), 'litnode.maxTicks must be an integer 20-5000');
  need(Array.isArray(ln.modes) && ln.modes.length > 0 && ln.modes.every((m) => m === 'ranked' || m === 'casual'), 'litnode.modes must be a non-empty subset of ["ranked","casual"]');
  need(isInt(ln.eloK, 1, 64), 'litnode.eloK must be an integer 1-64');

  const elementIds = new Set<string>();
  need(Array.isArray(cfg.elements) && cfg.elements.length > 0, 'elements must be a non-empty list');
  for (const e of cfg.elements ?? []) {
    need(CARD_ID.test(e.id ?? ''), `element id ${JSON.stringify(e.id)} must be kebab-case`);
    need(!elementIds.has(e.id), `element ${e.id} is defined twice`);
    elementIds.add(e.id);
  }
  for (const e of cfg.elements ?? []) for (const b of e.beats ?? []) need(elementIds.has(b), `element ${e.id} beats unknown element ${b}`);

  const mapping = (name: string, m: StatMapping | undefined, lo: number, hi: number): void => {
    need(!!m && STATS.includes(m.stat), `champion.${name}.stat must be one of ${STATS.join(', ')}`);
    need(!!m && isInt(m.min, lo, hi) && isInt(m.max, lo, hi) && m.min <= m.max, `champion.${name} min/max must be integers ${lo}-${hi} with min <= max`);
  };
  const ch = cfg.champion;
  mapping('life', ch?.life, 1, 999);
  mapping('spellPower', ch?.spellPower, 0, 20);
  mapping('unitAttack', ch?.unitAttack, 0, 20);
  mapping('openingHand', ch?.openingHand, 0, 10);

  const r = cfg.rules ?? ({} as GameConfig['rules']);
  need(isInt(r.boardSlots, 1, 5), 'rules.boardSlots must be 1-5 (the action encoding addresses 5 own units)');
  need(isInt(r.relicSlots, 0, 5), 'rules.relicSlots must be 0-5');
  need(isInt(r.handLimit, 1, 16), 'rules.handLimit must be 1-16 (the action encoding addresses 16 hand cards)');
  need(isInt(r.energyStart, 0, 99) && isInt(r.energyMax, 1, 99) && isInt(r.energyPerTurn, 0, 99), 'rules.energyStart/energyMax/energyPerTurn must be small integers');
  need(isInt(r.elementBonus, 0, 99), 'rules.elementBonus must be an integer 0-99');
  need(isInt(r.secondPlayerEnergy, 0, 99), 'rules.secondPlayerEnergy must be an integer 0-99');
  need(typeof r.fatigue === 'boolean', 'rules.fatigue must be true or false');

  const ids = new Set<string>();
  need(Array.isArray(cfg.cards) && cfg.cards.length > 0, 'cards must be a non-empty list');
  for (const c of cfg.cards ?? []) {
    const at = `card ${JSON.stringify(c.id)}`;
    need(CARD_ID.test(c.id ?? ''), `${at}: id must be kebab-case`);
    need(!ids.has(c.id), `${at}: defined twice`);
    ids.add(c.id);
    need(typeof c.name === 'string' && c.name.length > 0, `${at}: name is required`);
    need(elementIds.has(c.element), `${at}: unknown element ${JSON.stringify(c.element)}`);
    need(isInt(c.cost, 0, 99), `${at}: cost must be an integer 0-99`);
    if (c.type === 'unit') {
      need(isInt(c.attack, 0, 99) && isInt(c.health, 1, 99), `${at}: a unit needs integer attack (0-99) and health (1-99)`);
      for (const k of c.keywords ?? []) need(k === 'guard' || k === 'haste', `${at}: unknown keyword ${k}`);
    } else if (c.type === 'spell' || c.type === 'relic') {
      const e = c.effect;
      need(!!e, `${at}: a ${c.type} needs an effect`);
      if (e) {
        if (e.op === 'buff') need((e.attack ?? 0) >= 0 && (e.health ?? 0) >= 0 && ((e.attack ?? 0) > 0 || (e.health ?? 0) > 0), `${at}: buff needs attack and/or health > 0`);
        else need(['damage', 'heal', 'draw', 'energy'].includes(e.op) && isInt(e.amount, 1, 99), `${at}: effect op must be damage|heal|draw|energy|buff with an integer amount 1-99`);
      }
    } else {
      errs.push(`${at}: type must be unit, spell or relic`);
    }
  }

  let deckSize = 0;
  for (const [id, n] of Object.entries(cfg.deck ?? {})) {
    need(ids.has(id), `deck references unknown card ${id}`);
    need(isInt(n, 1, 60), `deck count for ${id} must be an integer 1-60`);
    deckSize += Number.isInteger(n) ? n : 0;
  }
  need(deckSize >= 5 && deckSize <= 120, `deck must hold 5-120 cards (has ${deckSize})`);
  return errs;
}

export function compileGame(cfg: GameConfig): CompiledGame {
  const errs = validateGame(cfg);
  if (errs.length) throw new Error(`invalid game config:\n- ${errs.join('\n- ')}`);
  const elementIndex: Record<string, number> = {};
  cfg.elements.forEach((e, i) => { elementIndex[e.id] = i; });
  const beats = cfg.elements.map((a) => cfg.elements.map((b) => (a.beats ?? []).includes(b.id)));
  const cardIndex: Record<string, number> = {};
  cfg.cards.forEach((c, i) => { cardIndex[c.id] = i; });
  const deckList: number[] = [];
  // Object key order is insertion order for string keys, so this is stable across machines.
  for (const [id, n] of Object.entries(cfg.deck)) for (let i = 0; i < n; i++) deckList.push(cardIndex[id]);
  return { config: cfg, cards: cfg.cards, cardElement: cfg.cards.map((c) => elementIndex[c.element]), beats, deckList, cardIndex };
}
