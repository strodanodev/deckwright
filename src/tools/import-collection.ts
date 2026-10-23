/**
 * Turn an NFT collection snapshot (`deckwright snapshot`) into a playable card set: every design becomes a
 * unit whose cost, attack and health come from its ERC-6699 CoreStats, and the template's neutral spells
 * and relics are added so the deck has answers.
 *
 *   deckwright import <cards.json> --id my-game [--out games] [--title "My Duel"] [--max-cards 300] [--deck-units 40]
 *
 * Cost and rarity: from the Kind trait when every card has a known Rapture Kind, otherwise from the
 * card's stat power (strength + agility + resilience + intelligence) in quintiles. Elements form a cycle
 * (each beats the next); Rapture's four keep their own cycle. Cards with no stats count as neutral.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { validateGame } from '../core/game';
import type { CardDef, GameConfig, Keyword } from '../core/types';
import { die, flag, parseArgs } from './common';
import { pkgPath } from './paths';

interface SnapshotCard {
  tokenId: string;
  slug?: string;
  name: string;
  kind?: string;
  element?: string;
  stats?: { str: number; agi: number; res: number; int: number } | null;
  image?: string;
}
interface Snapshot {
  collection: { name: string; chainId: number; address: string };
  cards: SnapshotCard[];
}

/** Rapture tiers, used when every card carries one of these Kinds. */
const KIND: Record<string, { cost: number; rarity: string }> = {
  Mortal: { cost: 1, rarity: 'common' },
  King: { cost: 2, rarity: 'uncommon' },
  Demigod: { cost: 3, rarity: 'rare' },
  Titan: { cost: 4, rarity: 'epic' },
  God: { cost: 5, rarity: 'legendary' },
};
/** Rapture's four elements as a cycle: water quenches lava, lava melts metal, metal splits earth, earth dams water. */
const RAPTURE_BEATS: Record<string, string[]> = { water: ['lava'], lava: ['metal'], metal: ['earth'], earth: ['water'] };

const args = parseArgs();
const snapPath = args._[0] ?? die('usage: deckwright import <cards.json> --id my-game [--out games]');
const id = flag(args, 'id') ?? die('--id <game-id> is required');
const snap = JSON.parse(readFileSync(resolve(snapPath), 'utf8')) as Snapshot;
const template = JSON.parse(readFileSync(pkgPath('templates', 'starter.game.json'), 'utf8')) as GameConfig;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const U16 = 65535;

const maxCards = Number(flag(args, 'max-cards') ?? 300);
const source = snap.cards.slice(0, maxCards);
if (source.length < snap.cards.length) console.log(`using the first ${source.length} of ${snap.cards.length} cards (--max-cards)`);
const NEUTRAL = { str: 32768, agi: 32768, res: 32768, int: 32768 };
const statsOf = (c: SnapshotCard): NonNullable<SnapshotCard['stats']> => c.stats ?? NEUTRAL;
const elementOf = (c: SnapshotCard): string => slug(c.element ?? '') || 'neutral';

const elementIds = [...new Set(source.map(elementOf))].filter((e) => e !== 'neutral').sort();
const rapture = elementIds.length > 0 && elementIds.every((e) => e in RAPTURE_BEATS);
const elements = [
  { id: 'neutral', name: 'Neutral', color: '#b8b8b8' },
  ...elementIds.map((e, i) => ({
    id: e,
    name: e[0].toUpperCase() + e.slice(1),
    beats: rapture ? RAPTURE_BEATS[e].filter((b) => elementIds.includes(b)) : elementIds.length > 1 ? [elementIds[(i + 1) % elementIds.length]] : [],
  })),
];

// Tiers: Rapture Kinds when every card has one, else stat-power quintiles (1 = weakest fifth).
const byKind = source.every((c) => c.kind != null && c.kind in KIND);
const power = (c: SnapshotCard): number => { const s = statsOf(c); return s.str + s.agi + s.res + s.int; };
const sortedPower = source.map(power).sort((a, b) => a - b);
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const tierOf = (c: SnapshotCard): { cost: number; rarity: string } => {
  if (byKind) return KIND[c.kind!];
  const rank = sortedPower.findIndex((p) => p >= power(c));
  const q = Math.min(4, Math.floor((rank / Math.max(1, sortedPower.length)) * 5));
  return { cost: q + 1, rarity: RARITY[q] };
};

const used = new Set<string>();
const units: CardDef[] = source.map((c) => {
  const st = statsOf(c);
  const tier = tierOf(c);
  const keywords: Keyword[] = [];
  if (st.res >= st.str * 1.25) keywords.push('guard');
  if (st.agi >= st.str && st.agi >= st.res) keywords.push('haste');
  let cid = slug(c.slug || c.name) || `token-${c.tokenId}`;
  if (used.has(cid)) cid = `${cid}-${c.tokenId.slice(-6)}`;
  used.add(cid);
  return {
    id: cid,
    name: c.name,
    type: 'unit',
    element: elementOf(c),
    cost: tier.cost,
    attack: Math.max(1, Math.round((st.str / U16) * (tier.cost + 3))),
    health: Math.max(1, Math.round((st.res / U16) * (tier.cost + 4))),
    ...(keywords.length ? { keywords } : {}),
    rarity: tier.rarity,
    ...(c.image ? { art: c.image } : {}),
    token: { chainId: snap.collection.chainId, collection: snap.collection.address, tokenId: c.tokenId },
  };
});
const support = template.cards.filter((c) => c.type !== 'unit' && c.element === 'neutral');

// The deck every player plays: up to --deck-units units (spread across the set) plus two of each support card.
const deckUnits = Math.min(units.length, Number(flag(args, 'deck-units') ?? 60));
const deck: Record<string, number> = {};
for (let i = 0; i < deckUnits; i++) deck[units[Math.floor((i * units.length) / deckUnits)].id] = 1;
for (const s of support) deck[s.id] = 2;

const game: GameConfig = {
  ...template,
  title: flag(args, 'title') ?? snap.collection.name,
  description: `Card duel built from ${snap.collection.name} (${snap.collection.address} on chain ${snap.collection.chainId}).`,
  litnode: { ...template.litnode, rulesetId: `${id}.v1` },
  elements,
  cards: [...units, ...support],
  deck,
};
const errs = validateGame(game);
if (errs.length) die(`generated config is invalid:\n- ${errs.join('\n- ')}`);

const outDir = resolve(flag(args, 'out') ?? 'games');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${id}.game.json`);
writeFileSync(file, `${JSON.stringify(game, null, 2)}\n`);
console.log(`created ${file}: ${units.length} units from ${snap.collection.name}, ${support.length} support cards, deck of ${Object.values(deck).reduce((a, b) => a + b, 0)}`);
