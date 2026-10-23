/**
 * Deckwright data model.
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
 * What a spell does when played, or what a relic does at the start of each of its owner's turns.
 * - damage: hit the chosen target (enemy champion or unit) for `amount` (+ champion spellPower)
 * - heal:   restore `amount` life to your champion
 * - draw:   draw `amount` cards
 * - buff:   give one of your units +attack/+health
 * - energy: gain `amount` energy this turn
 */
export type Effect =
  | { op: 'damage'; amount: number }
  | { op: 'heal'; amount: number }
  | { op: 'draw'; amount: number }
  | { op: 'buff'; attack?: number; health?: number }
  | { op: 'energy'; amount: number };

export type Keyword = 'guard' | 'haste';

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
  /** Spells and relics. */
  effect?: Effect;
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
}

/**
 * 'declared': each player declares their own deck (for example the cards their wallet holds) as the first
 * entries of the match log, one card per entry, before turn 1. The log stays the whole truth, so any node
 * or witness replays it; ownership is checked by the client and relay, not by the rules.
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
  guard: boolean;
  ready: boolean;
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
}

export interface MatchState {
  v: 1;
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
  /** Declared-deck matches only: the match seed (decks are shuffled once both are declared). */
  seed?: string;
  /** Declared-deck matches only: each side's opening hand size, drawn once decks are declared. */
  opening?: [number, number];
}

/** What LitNode passes `init` as `ctx`. */
export interface InitContext {
  agents?: Record<string, { stats?: AgentStats } | undefined>;
}
