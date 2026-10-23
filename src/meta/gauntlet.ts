/**
 * The Gauntlet: a run of eight bot matches of rising difficulty. Win and you pick a reward, lose and the run
 * ends. Everything is seeded from the run's seed, so a run can be resumed, shared and replayed. Rewards
 * never touch the rules:
 * - a card swap (declared-deck games): the picked card replaces the weakest card in your deck;
 * - a blessing: +stat on your champion, which goes into `init` like any hydrated stat.
 * So every Gauntlet match replays under the game's own rulesetId. Kernel-compatible: only the deck and
 * reward pools are card-game specific.
 */
import { seededRandom } from '../core/rng';
import type { Rules } from '../core/rules';
import { normalizeStats } from '../core/champion';
import type { BotLevel } from '../core/bot';
import type { AgentStats, StatName } from '../core/types';

export const STAGES = 8;
const STATS: StatName[] = ['strength', 'agility', 'resilience', 'intelligence'];
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
/** A blessing's size: about a third of a stat's range, so two or three blessings visibly change a champion. */
export const BLESSING = 12_000;

export interface GauntletRun {
  v: 1;
  seed: string;
  /** Matches won so far; the next match is stage `wins + 1`. */
  wins: number;
  over: boolean;
  /** Won all eight. */
  cleared: boolean;
  champion: { tokenId?: string; stats: Required<AgentStats> };
  /** Declared-deck games: your deck (card indices). Empty for fixed-deck games. */
  deck: number[];
  blessings: Partial<Record<StatName, number>>;
  /** Rewards to choose from after a win; empty while a match is next. */
  offers: Reward[];
  started: number;
  /** Set once a finished run has been added to the profile's totals. */
  counted?: boolean;
}

export type Reward =
  | { kind: 'card'; card: number; replaces: number }
  | { kind: 'bless'; stat: StatName; amount: number };

export interface Opponent {
  stage: number;
  name: string;
  level: BotLevel;
  tokenId?: string;
  stats: Required<AgentStats>;
  /** Declared-deck games: the opponent's deck. */
  deck: number[];
}

const rarityRank = (r: string | undefined, cost: number): number => { const i = RARITY.indexOf(r ?? ''); return i >= 0 ? i : Math.min(4, Math.max(0, cost - 1)); };
const STAGE_NAMES = ['Squire', 'Raider', 'Warden', 'Duelist', 'Champion', 'Warlord', 'Ascendant', 'The Forgemaster'];

export function createGauntlet(rules: Rules) {
  const { cards, config } = rules.game;
  const dr = config.deckRules?.mode === 'declared' ? config.deckRules : null;
  const rank = (c: number): number => rarityRank(cards[c].rarity, cards[c].cost);
  const tokens = cards.map((c, i) => (c.token ? i : -1)).filter((i) => i >= 0);
  // Summoned tokens without art or rarity still count as cards; only cards a deck may hold are offered.
  const pool = cards.map((_, i) => i);

  /** A legal deck of `size` cards drawn from cards whose rarity rank is at most `maxRank`, at most maxCopies each. */
  const deckFrom = (rnd: () => number, maxRank: number): number[] => {
    if (!dr) return [];
    const list = pool.filter((c) => rank(c) <= maxRank).flatMap((c) => Array.from({ length: dr.maxCopies }, () => c));
    for (let i = list.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    const deck = list.slice(0, dr.size);
    // Too few low-rarity cards: top up from the suggested deck so the deck is always legal.
    for (const c of rules.game.suggestedDeck) if (deck.length < dr.size && deck.filter((d) => d === c).length < dr.maxCopies) deck.push(c);
    return deck;
  };

  const championStats = (run: GauntletRun): Required<AgentStats> => {
    const s = { ...run.champion.stats };
    for (const k of STATS) s[k] = Math.min(65535, s[k] + (run.blessings[k] ?? 0));
    return s;
  };

  const offersFor = (run: GauntletRun): Reward[] => {
    const rnd = seededRandom(`${run.seed}|offers|${run.wins}`);
    const out: Reward[] = [];
    if (dr && run.deck.length) {
      // Card offers get rarer as the run goes on; each replaces the weakest card you hold (lowest rarity, then cost).
      const minRank = Math.min(4, Math.floor(run.wins / 2));
      const candidates = pool.filter((c) => rank(c) >= minRank && run.deck.filter((d) => d === c).length < dr.maxCopies);
      const weakest = [...run.deck].sort((a, b) => rank(a) - rank(b) || cards[a].cost - cards[b].cost || a - b)[0];
      const seen = new Set<number>();
      for (let tries = 0; out.length < 2 && tries < 50 && candidates.length; tries++) {
        const card = candidates[rnd() % candidates.length];
        if (seen.has(card) || card === weakest) continue;
        seen.add(card);
        out.push({ kind: 'card', card, replaces: weakest });
      }
    }
    const stats = [...STATS];
    while (out.length < 3) { const stat = stats.splice(rnd() % stats.length, 1)[0]; out.push({ kind: 'bless', stat, amount: BLESSING }); }
    return out;
  };

  return {
    stages: STAGES,
    /** A new run with the chosen champion (or none). Declared-deck games start from a deck of commons to rares. */
    start(seed: string, champion?: { tokenId?: string; stats?: AgentStats }, now = Date.now()): GauntletRun {
      return {
        v: 1, seed, wins: 0, over: false, cleared: false,
        champion: { ...(champion?.tokenId ? { tokenId: String(champion.tokenId) } : {}), stats: normalizeStats(champion?.stats) },
        deck: deckFrom(seededRandom(`${seed}|start`), 2),
        blessings: {}, offers: [], started: now,
      };
    },
    /** Who stage `wins + 1` is: stronger stats, rarer decks and a smarter bot as the run goes on. */
    opponent(run: GauntletRun): Opponent {
      const stage = run.wins + 1;
      const rnd = seededRandom(`${run.seed}|stage|${stage}`);
      const tokenId = tokens.length ? cards[tokens[rnd() % tokens.length]].token!.tokenId : undefined;
      const base = Math.min(65535, 4000 + stage * 3500);
      const stats = normalizeStats(Object.fromEntries(STATS.map((k) => [k, base + (rnd() % 8000) - 4000])));
      return { stage, name: STAGE_NAMES[stage - 1] ?? `Stage ${stage}`, level: stage <= 2 ? 1 : stage <= 6 ? 2 : 3, ...(tokenId ? { tokenId: String(tokenId) } : {}), stats, deck: deckFrom(rnd, stage <= 2 ? 1 : stage <= 5 ? 2 : stage <= 7 ? 3 : 4) };
    },
    /** What you bring to the next match: your champion with its blessings, and your deck. */
    player(run: GauntletRun): { tokenId?: string; stats: Required<AgentStats>; deck: number[] } {
      return { ...(run.champion.tokenId ? { tokenId: run.champion.tokenId } : {}), stats: championStats(run), deck: [...run.deck] };
    },
    /** Record a match. A win offers rewards (or clears the run after the last stage); a loss or draw ends it. */
    result(run: GauntletRun, won: boolean): GauntletRun {
      if (run.over || run.offers.length) return run;
      if (!won) return { ...run, over: true };
      const wins = run.wins + 1;
      const next = { ...run, wins };
      return wins >= STAGES ? { ...next, over: true, cleared: true } : { ...next, offers: offersFor(next) };
    },
    /** Take one of the offered rewards (index into `run.offers`). */
    choose(run: GauntletRun, i: number): GauntletRun {
      const r = run.offers[i];
      if (!r) return run;
      if (r.kind === 'bless') return { ...run, offers: [], blessings: { ...run.blessings, [r.stat]: (run.blessings[r.stat] ?? 0) + r.amount } };
      const deck = [...run.deck];
      const at = deck.indexOf(r.replaces);
      if (at >= 0) deck[at] = r.card;
      return { ...run, offers: [], deck };
    },
  };
}
export type Gauntlet = ReturnType<typeof createGauntlet>;
