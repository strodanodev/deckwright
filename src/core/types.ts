/**
 * Tessaract data model.
 *
 * Everything under `core/` is pure TypeScript with no engine, DOM or Node imports.
 * The same files are bundled into the LitNode ruleset (replayed by host and witnesses)
 * and imported by the Genesys client (rendered locally), so both sides compute the
 * exact same state from the same input log.
 */

/** ERC-6699 CoreStats as LitNode hydrates them into `ctx.agents[player].stats` (uint16 each). */
export interface AgentStats {
  strength?: number;
  agility?: number;
  resilience?: number;
  intelligence?: number;
}

export type StatName = keyof AgentStats;

export type CardType = 'unit' | 'spell' | 'relic';

/**
 * Who an effect hits. Chosen specs take the target the player picks (spells, hero powers and a unit's `play`
 * ability); automatic specs need no choice and are the only kind other triggers and relics may use.
 * - chosen:    'enemy' (enemy champion or unit), 'enemy-unit', 'own-unit', 'any-unit'
 * - automatic: 'self' (your champion), 'enemy-champion', 'all-enemy-units', 'all-own-units', 'all-units',
 *              'weakest-enemy' (the enemy unit with the least health, leftmost on ties; else the enemy champion),
 *              'newest-own-unit', 'this' (the unit whose ability it is)
 * Enemy units with `elusive` can't be chosen; automatic effects still reach them.
 */
export type TargetSpec =
  | 'enemy' | 'enemy-unit' | 'own-unit' | 'any-unit'
  | 'self' | 'enemy-champion' | 'all-enemy-units' | 'all-own-units' | 'all-units' | 'weakest-enemy' | 'newest-own-unit' | 'this';

/**
 * What a spell, ability, hero power or relic does. Every op is defined once, in core/effects.ts.
 * - damage: deal `amount` (+ spellPower for spells) to the target(s). Default target: 'enemy' when chosen, else 'enemy-champion'
 * - heal:   restore `amount` life to your champion, or health to units (up to their maximum). Default 'self'
 * - draw:   draw `amount` cards
 * - buff:   +attack/+health to unit(s). Default 'own-unit' when chosen, else 'newest-own-unit'
 * - energy: gain `amount` energy this turn
 * - summon: put `count` (default 1) copies of unit card `card` onto your board
 * - shield: give unit(s) a shield that blocks the next damage. Default like buff
 */
export type Effect =
  | { op: 'damage'; amount: number; target?: TargetSpec }
  | { op: 'heal'; amount: number; target?: TargetSpec }
  | { op: 'draw'; amount: number }
  | { op: 'buff'; attack?: number; health?: number; target?: TargetSpec }
  | { op: 'energy'; amount: number }
  | { op: 'summon'; card: string; count?: number }
  | { op: 'shield'; target?: TargetSpec };

/**
 * - guard:     enemies must attack guards first
 * - haste:     can attack the turn it is played
 * - rush:      can attack units (not the champion) the turn it is played
 * - lifesteal: damage it deals heals its champion
 * - shield:    the first damage it would take is blocked
 * - poison:    any damage it deals to a unit destroys that unit
 * - elusive:   enemy spells, powers and abilities can't choose it
 */
export type Keyword = 'guard' | 'haste' | 'rush' | 'lifesteal' | 'shield' | 'poison' | 'elusive';

/** When a unit's ability fires. 'play' may take a chosen target; the others are automatic. */
export type Trigger = 'play' | 'death' | 'turnStart' | 'attack';

export interface Ability {
  on: Trigger;
  effect: Effect;
}

/**
 * A champion's hero power: once per turn, for `cost` energy. Each champion gets the first power whose
 * conditions all match (an entry with none is the default, for players without a champion). Conditions read
 * the champion's card in this game (found by token id) and its normalized ERC-6699 stats.
 */
export interface HeroPower {
  id: string;
  name: string;
  cost: number;
  effect: Effect;
  /** The champion card's element. */
  element?: string;
  /** The champion card's kind (a collection trait, such as a Rapture Kind). */
  kind?: string;
  /** The champion's highest ERC-6699 stat (ties go to the first in strength, agility, resilience, intelligence order). */
  stat?: StatName;
}

/** Optional link from a card definition to the NFT it represents. Display-only in v1. */
export interface CardToken {
  chainId: number;
  collection: string;
  tokenId: string;
}

export interface CardDef {
  /** Stable kebab-case id; decks reference cards by it. */
  id: string;
  name: string;
  type: CardType;
  /** One of `GameConfig.elements[].id`. */
  element: string;
  cost: number;
  /** Units only. */
  attack?: number;
  /** Units only. */
  health?: number;
  keywords?: Keyword[];
  /** Units only: effects that fire on play, on death, at its owner's turn start, or when it attacks. */
  abilities?: Ability[];
  /** Spells and relics. */
  effect?: Effect;
  /** A collection trait (such as a Rapture Kind), for display and hero-power matching. */
  kind?: string;
  /** Card face: a project asset path for bundled art, or an http(s)/ipfs URL for NFT art. */
  art?: string;
  rarity?: string;
  token?: CardToken;
}

export interface ElementDef {
  id: string;
  name: string;
  /** Element ids this element deals bonus damage to. */
  beats?: string[];
  /** CSS colour for UI accents. */
  color?: string;
}

/** Maps one ERC-6699 stat (0..65535) onto a bounded integer range. */
export interface StatMapping {
  stat: StatName;
  min: number;
  max: number;
}

/** How a player's ERC-6699 champion (the token they queue with) shapes their side. */
export interface ChampionConfig {
  life: StatMapping;
  /** Bonus damage on damage spells. */
  spellPower: StatMapping;
  /** Bonus attack on every unit you play. */
  unitAttack: StatMapping;
  openingHand: StatMapping;
  /** Optional hero powers; see HeroPower. */
  powers?: HeroPower[];
}

export interface RulesConfig {
  boardSlots: number;
  relicSlots: number;
  handLimit: number;
  energyStart: number;
  energyMax: number;
  energyPerTurn: number;
  /** Extra damage when the attacker's element beats the defender's. */
  elementBonus: number;
  /** Damage when drawing from an empty deck grows by 1 each time. */
  fatigue: boolean;
  /** The second player starts with this much extra energy. */
  secondPlayerEnergy: number;
  /** The second player's opening hand holds this many extra cards (default 0): a finer lever than energy. */
  secondPlayerCards?: number;
}

/**
 * 'declared': each player declares their own deck (for example the cards their wallet holds) as the first
 * entries of the match log, one card per entry, before turn 1. The log stays the whole truth, so any node
 * or witness replays it. Ownership is not a rule: the relay enforces it for owned-only matches (tools/chain-check.ts).
 */
export interface DeckRules {
  mode: 'fixed' | 'declared';
  /** Cards per declared deck. */
  size: number;
  /** Copies of one card allowed in a declared deck. */
  maxCopies: number;
}

export interface LitNodeConfig {
  /** `name.vN`. Bump N on any rules or card change: a new version is a new ruleset. */
  rulesetId: string;
  /** Nominal; a turn game records one log entry per action, not per wall-clock tick. */
  tickRate: number;
  /** Hard cap on log entries. At the cap, the higher life total wins. */
  maxTicks: number;
  modes: Array<'ranked' | 'casual'>;
  eloK: number;
  /** Where the arcade launches the client. */
  url?: string;
  cover?: string;
  accent?: string;
}

export interface GameConfig {
  $schema?: string;
  title: string;
  description?: string;
  litnode: LitNodeConfig;
  elements: ElementDef[];
  champion: ChampionConfig;
  rules: RulesConfig;
  cards: CardDef[];
  /**
   * The default deck: `{ cardId: copies }`. With `deckRules.mode: 'fixed'` (the default) every player plays
   * it; with `'declared'` it is the suggested deck and the fallback for a player who does not declare one.
   */
  deck: Record<string, number>;
  /** How decks are chosen. Omit for 'fixed'. */
  deckRules?: DeckRules;
  /** Optional card back for the client. */
  cardBack?: string;
}

// ---------------------------------------------------------------- state

export interface UnitState {
  /** Index into the compiled card list. */
  c: number;
  atk: number;
  hp: number;
  /** Health cap for heals: the card's health plus buffs. */
  max: number;
  guard: boolean;
  ready: boolean;
  /** Played this turn (a rush unit may attack only units). */
  fresh: boolean;
  /** Blocks the next damage. */
  shield: boolean;
}

export interface PlayerState {
  id: string;
  life: number;
  /** Starting life; heals cap here. */
  maxLife: number;
  energy: number;
  energyCap: number;
  spellPower: number;
  unitAttack: number;
  /** Card indices, top of deck last. */
  deck: number[];
  hand: number[];
  board: UnitState[];
  relics: number[];
  fatigue: number;
  /** Index into `champion.powers`, or -1 for none. */
  power: number;
  powerUsed: boolean;
}

export interface MatchState {
  v: 2;
  /** Log entries consumed so far. */
  beat: number;
  /** Index of the player to act. */
  turn: 0 | 1;
  turnNo: number;
  over: boolean;
  /** -1 none yet, 0 or 1 a side, 2 a draw. */
  winner: -1 | 0 | 1 | 2;
  p: [PlayerState, PlayerState];
  /** Last accepted action, for UI and animation. 0 when the beat was a no-op. */
  last: number;
  /** Declared-deck matches only: 'decks' until both decks are declared, then 'play'. */
  phase?: 'decks' | 'play';
  /** Declared-deck matches only: the cards each side has declared so far (card indices). */
  decl?: [number[], number[]];
  /** The match seed: decks and draws come from it. */
  seed: string;
  /**
   * Draw entropy: folded from every accepted action. Draws come from the seed and `turnEnt` (the entropy when
   * the turn began), so nobody can compute a draw before the opponent has finished the turn before it.
   */
  ent: number;
  turnEnt: number;
  /** Draws made since the turn began. */
  drawn: number;
  /** Declared-deck matches only: each side's opening hand size, drawn once decks are declared. */
  opening?: [number, number];
}

/** What LitNode passes `init` as `ctx`. */
export interface InitContext {
  agents?: Record<string, { stats?: AgentStats; tokenId?: string } | undefined>;
}
