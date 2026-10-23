import { checkEffect, KEYWORDS, TRIGGERS } from './effects';
import type { CardDef, GameConfig, StatMapping } from './types';

/** A validated config with cards indexed for the rules engine. */
export interface CompiledGame {
  config: GameConfig;
  cards: CardDef[];
  /** Element index per card, parallel to `cards`. */
  cardElement: number[];
  /** `beats[a][b]`: element a deals bonus damage to element b. */
  beats: boolean[][];
  /** The default deck as card indices, before shuffling. */
  deckList: number[];
  /** Declared-deck games: the suggested declaration (deckRules.size cards spread over the default deck). */
  suggestedDeck: number[];
  cardIndex: Record<string, number>;
  /** NFT token id -> card index, for finding a champion's card (element, kind) from `ctx.agents[p].tokenId`. */
  tokenCard: Record<string, number>;
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
  const unitIds = new Set((cfg.cards ?? []).filter((c) => c.type === 'unit').map((c) => c.id));
  if (ch?.powers !== undefined) {
    need(Array.isArray(ch.powers) && ch.powers.length <= 32, 'champion.powers must be a list of at most 32 powers');
    for (const pw of Array.isArray(ch.powers) ? ch.powers : []) {
      const at = `champion power ${JSON.stringify(pw?.id)}`;
      need(CARD_ID.test(pw?.id ?? ''), `${at}: id must be kebab-case`);
      need(typeof pw?.name === 'string' && pw.name.length > 0, `${at}: name is required`);
      need(isInt(pw?.cost, 0, 10), `${at}: cost must be an integer 0-10`);
      need(pw?.element === undefined || elementIds.has(pw.element), `${at}: unknown element ${JSON.stringify(pw?.element)}`);
      need(pw?.stat === undefined || STATS.includes(pw.stat), `${at}: stat must be one of ${STATS.join(', ')}`);
      for (const e of checkEffect(pw?.effect, unitIds, { automatic: false, onUnit: false })) errs.push(`${at}: ${e}`);
    }
  }

  const r = cfg.rules ?? ({} as GameConfig['rules']);
  need(isInt(r.boardSlots, 1, 5), 'rules.boardSlots must be 1-5 (the action encoding addresses 5 own units)');
  need(isInt(r.relicSlots, 0, 5), 'rules.relicSlots must be 0-5');
  need(isInt(r.handLimit, 1, 16), 'rules.handLimit must be 1-16 (the action encoding addresses 16 hand cards)');
  need(isInt(r.energyStart, 0, 99) && isInt(r.energyMax, 1, 99) && isInt(r.energyPerTurn, 0, 99), 'rules.energyStart/energyMax/energyPerTurn must be small integers');
  need(isInt(r.elementBonus, 0, 99), 'rules.elementBonus must be an integer 0-99');
  need(isInt(r.secondPlayerEnergy, 0, 99), 'rules.secondPlayerEnergy must be an integer 0-99');
  need(r.secondPlayerCards === undefined || isInt(r.secondPlayerCards, 0, 5), 'rules.secondPlayerCards must be an integer 0-5');
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
      for (const k of c.keywords ?? []) need(k in KEYWORDS, `${at}: unknown keyword ${k} (known: ${Object.keys(KEYWORDS).join(', ')})`);
      need(c.abilities === undefined || (Array.isArray(c.abilities) && c.abilities.length <= 3), `${at}: abilities must be a list of at most 3`);
      for (const a of Array.isArray(c.abilities) ? c.abilities : []) {
        need(a?.on in TRIGGERS, `${at}: ability trigger must be one of ${Object.keys(TRIGGERS).join(', ')}`);
        for (const e of checkEffect(a?.effect, unitIds, { automatic: a?.on !== 'play', onUnit: a?.on !== 'death' })) errs.push(`${at}: ${a?.on} ability: ${e}`);
      }
    } else if (c.type === 'spell' || c.type === 'relic') {
      need(!!c.effect, `${at}: a ${c.type} needs an effect`);
      if (c.effect) for (const e of checkEffect(c.effect, unitIds, { automatic: c.type === 'relic', onUnit: false })) errs.push(`${at}: ${e}`);
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

  const dr = cfg.deckRules;
  if (dr !== undefined) {
    need(dr.mode === 'fixed' || dr.mode === 'declared', 'deckRules.mode must be "fixed" or "declared"');
    need(isInt(dr.size, 5, 60), 'deckRules.size must be an integer 5-60');
    need(isInt(dr.maxCopies, 1, 10), 'deckRules.maxCopies must be an integer 1-10');
    need(cfg.cards?.length <= 0x7fff, 'a declared-deck game can address at most 32767 cards');
    if (dr.mode === 'declared' && isInt(dr.size, 5, 60)) need(deckSize >= dr.size, `the default deck (${deckSize} cards) must hold at least deckRules.size (${dr.size}): it is the suggested and fallback deck`);
  }
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
  const tokenCard: Record<string, number> = {};
  cfg.cards.forEach((c, i) => { if (c.token) tokenCard[String(c.token.tokenId)] = i; });
  return { config: cfg, cards: cfg.cards, cardElement: cfg.cards.map((c) => elementIndex[c.element]), beats, deckList, suggestedDeck: suggestDeck(deckList, cfg.deckRules), cardIndex, tokenCard };
}

/** deckRules.size cards spread evenly over the default deck, within maxCopies (a sensible curve, deterministic). */
function suggestDeck(deckList: number[], rules: GameConfig['deckRules']): number[] {
  if (!rules || rules.mode !== 'declared') return [];
  const out: number[] = [];
  const count: Record<number, number> = {};
  const take = (c: number): void => { if (out.length < rules.size && (count[c] ?? 0) < rules.maxCopies) { out.push(c); count[c] = (count[c] ?? 0) + 1; } };
  for (let i = 0; i < rules.size; i++) take(deckList[Math.floor((i * deckList.length) / rules.size)]);
  for (const c of deckList) take(c); // fill any gaps left by maxCopies
  return out;
}
