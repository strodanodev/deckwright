/**
 * The design kit `deckwright import` applies to a collection: each element gets an archetype, and the archetype
 * gives its units keywords and abilities by tier (1 = cheapest, 5 = rarest), its own spells and relic, a token
 * unit, and a hero power for champions of that element. It turns a pile of stat lines into a set with
 * interaction; every number is a starting point for `deckwright sim` to tune.
 */
import type { Ability, CardDef, HeroPower, Keyword } from '../core/types';

export type Archetype = 'aggro' | 'control' | 'defense' | 'value';
const ORDER: Archetype[] = ['aggro', 'control', 'defense', 'value'];
/** Rapture's elements have fixed identities; other collections get archetypes in element order. */
const RAPTURE: Record<string, Archetype> = { lava: 'aggro', water: 'control', earth: 'defense', metal: 'value' };

export function archetypes(elementIds: string[]): Record<string, Archetype> {
  const rapture = elementIds.length > 0 && elementIds.every((e) => e in RAPTURE);
  return Object.fromEntries(elementIds.map((e, i) => [e, rapture ? RAPTURE[e] : ORDER[i % ORDER.length]]));
}

interface TierKit { keywords?: Keyword[]; abilities?: Ability[]; /** stat points the kit costs */ tax: number }
const TOKEN = 'construct';
const dmg = (amount: number, target: NonNullable<Extract<Ability['effect'], { op: 'damage' }>['target']>): Ability['effect'] => ({ op: 'damage', amount, target });

/** Per archetype, the kit for tiers 1-5. */
const UNITS: Record<Archetype, TierKit[]> = {
  aggro: [
    { keywords: ['haste'], tax: 1 },
    { keywords: ['rush'], abilities: [{ on: 'attack', effect: dmg(1, 'enemy-champion') }], tax: 1 },
    { abilities: [{ on: 'play', effect: dmg(2, 'enemy') }], tax: 2 },
    { keywords: ['rush'], abilities: [{ on: 'play', effect: dmg(1, 'all-enemy-units') }], tax: 2 },
    { keywords: ['haste'], abilities: [{ on: 'play', effect: dmg(3, 'enemy') }], tax: 3 },
  ],
  control: [
    { abilities: [{ on: 'play', effect: { op: 'heal', amount: 2 } }], tax: 1 },
    { abilities: [{ on: 'play', effect: dmg(1, 'enemy-unit') }], tax: 1 },
    { keywords: ['lifesteal'], tax: 1 },
    { abilities: [{ on: 'play', effect: dmg(1, 'all-enemy-units') }], tax: 2 },
    { keywords: ['lifesteal'], abilities: [{ on: 'play', effect: dmg(2, 'all-enemy-units') }], tax: 3 },
  ],
  defense: [
    { keywords: ['guard'], tax: 0 },
    { keywords: ['shield'], tax: 1 },
    { keywords: ['guard'], abilities: [{ on: 'turnStart', effect: { op: 'buff', health: 1, target: 'this' } }], tax: 1 },
    { keywords: ['guard', 'shield'], tax: 2 },
    { keywords: ['guard'], abilities: [{ on: 'play', effect: { op: 'shield', target: 'all-own-units' } }], tax: 2 },
  ],
  value: [
    { abilities: [{ on: 'death', effect: { op: 'summon', card: TOKEN } }], tax: 1 },
    { keywords: ['poison'], tax: 1 },
    { keywords: ['shield'], abilities: [{ on: 'death', effect: { op: 'summon', card: TOKEN } }], tax: 2 },
    { keywords: ['poison', 'shield'], tax: 2 },
    { keywords: ['shield'], abilities: [{ on: 'death', effect: { op: 'summon', card: TOKEN, count: 2 } }], tax: 3 },
  ],
};

/** Give a unit its archetype's kit for its tier, paying the kit's tax out of its stats (each stays at least 1). */
export function kitUnit(unit: CardDef, archetype: Archetype | undefined, tier: number): CardDef {
  if (!archetype) return unit;
  const kit = UNITS[archetype][Math.max(1, Math.min(5, tier)) - 1];
  let attack = unit.attack ?? 0, health = unit.health ?? 1;
  for (let t = 0; t < kit.tax; t++) {
    if (health >= attack && health > 1) health--;
    else if (attack > 1) attack--;
    else if (health > 1) health--;
  }
  const { keywords: _old, ...rest } = unit;
  return { ...rest, attack, health, ...(kit.keywords ? { keywords: kit.keywords } : {}), ...(kit.abilities ? { abilities: kit.abilities } : {}) };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Spells and a relic for each element, by archetype, plus the token unit some kits summon. */
export function kitSupport(elements: Array<{ id: string; name: string }>, arch: Record<string, Archetype>): CardDef[] {
  const out: CardDef[] = [];
  const add = (e: { id: string; name: string }, name: string, cost: number, type: 'spell' | 'relic', effect: CardDef['effect'], rarity = 'uncommon'): void => {
    out.push({ id: slug(`${e.name} ${name}`), name: `${e.name} ${name}`, type, element: e.id, cost, effect, rarity });
  };
  for (const e of elements) {
    switch (arch[e.id]) {
      case 'aggro':
        add(e, 'Burst', 1, 'spell', dmg(2, 'enemy'), 'common');
        add(e, 'Surge', 4, 'spell', dmg(5, 'enemy'), 'rare');
        add(e, 'Idol', 3, 'relic', { op: 'damage', amount: 1 });
        break;
      case 'control':
        add(e, 'Lash', 2, 'spell', dmg(3, 'enemy-unit'), 'common');
        add(e, 'Insight', 3, 'spell', { op: 'draw', amount: 2 }, 'rare');
        add(e, 'Tide', 4, 'spell', dmg(2, 'all-enemy-units'), 'rare');
        break;
      case 'defense':
        add(e, 'Ward', 1, 'spell', { op: 'shield', target: 'own-unit' }, 'common');
        add(e, 'Quake', 4, 'spell', dmg(2, 'all-units'), 'rare');
        add(e, 'Bastion', 3, 'relic', { op: 'shield', target: 'newest-own-unit' });
        break;
      case 'value':
        add(e, 'Assembly', 2, 'spell', { op: 'summon', card: TOKEN, count: 2 }, 'common');
        add(e, 'Overclock', 3, 'spell', { op: 'buff', attack: 3, health: 3 }, 'rare');
        break;
    }
  }
  const valueElement = elements.find((e) => arch[e.id] === 'value')?.id ?? elements[0]?.id;
  if (valueElement) out.push({ id: TOKEN, name: 'Construct', type: 'unit', element: valueElement, cost: 1, attack: 1, health: 1, rarity: 'common' });
  return out;
}

/** A hero power per element (its archetype's), and a default for players without a champion. */
export function kitPowers(elements: Array<{ id: string; name: string }>, arch: Record<string, Archetype>, hasToken: boolean): HeroPower[] {
  const powers: HeroPower[] = [];
  for (const e of elements) {
    const id = slug(`${e.name} power`);
    switch (arch[e.id]) {
      case 'aggro': powers.push({ id, name: `${e.name} Strike`, cost: 2, element: e.id, effect: dmg(2, 'enemy-champion') }); break;
      // Costs tuned on Rapture Duel v4 (sim, mixed decks): each power wins 45-56% against the others.
      case 'control': powers.push({ id, name: `${e.name} Bolt`, cost: 3, element: e.id, effect: dmg(1, 'enemy') }); break;
      case 'defense': powers.push({ id, name: `${e.name} Ward`, cost: 2, element: e.id, effect: { op: 'shield' } }); break;
      case 'value': if (hasToken) powers.push({ id, name: `${e.name} Forge`, cost: 1, element: e.id, effect: { op: 'summon', card: TOKEN } }); break;
    }
  }
  powers.push({ id: 'rally', name: 'Rally', cost: 2, effect: { op: 'buff', attack: 1, health: 1 } });
  return powers;
}
