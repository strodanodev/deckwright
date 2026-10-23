/**
 * A player's profile on this device: match history, streaks, per-champion records, Gauntlet and daily-puzzle
 * progress. Pure data and functions; where it is kept is the caller's `Store` (the site uses localStorage).
 * Genre-agnostic: the kernel's meta layer. Nothing here is a rule, so it never changes a ruleset.
 */
import type { GauntletRun } from './gauntlet';

export type MatchMode = 'practice' | 'relay' | 'gauntlet' | 'puzzle';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface MatchEntry {
  /** Unix ms. */
  at: number;
  mode: MatchMode;
  result: MatchResult;
  turns: number;
  /** The rulesetId it was played under (replays only work under the same one). */
  ruleset: string;
  /** Your champion's token id, if you had one. */
  champion?: string;
  /** Who you played: "House bot", a stage name, an opponent id. */
  opponent?: string;
  /** A replay share code (src/client/replay.ts). */
  replay?: string;
  /** Mode detail, such as "stage 3" or a puzzle date. */
  detail?: string;
}

export interface Profile {
  v: 1;
  /** The game, by rulesetId without its version: a profile outlives balance patches. */
  game: string;
  matches: MatchEntry[];
  gauntlet: { runs: number; cleared: number; bestStage: number; current: GauntletRun | null };
  /** Daily puzzles solved, by date (YYYY-MM-DD). */
  puzzles: Record<string, { at: number; actions: number }>;
}

/** Where profiles are kept. The site passes localStorage; tests pass a Map. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** History is capped so a profile (and its replay codes) stays small in browser storage. */
export const MAX_MATCHES = 200;
const MAX_REPLAY = 16 * 1024;

export const gameKey = (rulesetId: string): string => rulesetId.replace(/\.v\d+$/, '');
const storageKey = (game: string): string => `deckwright.profile.${game}`;

export const emptyProfile = (game: string): Profile => ({ v: 1, game, matches: [], gauntlet: { runs: 0, cleared: 0, bestStage: 0, current: null }, puzzles: {} });

/** Load a profile; anything unreadable (another version, a hand edit, a full disk) starts fresh rather than failing. */
export function loadProfile(store: Store | null, rulesetId: string): Profile {
  const game = gameKey(rulesetId);
  try {
    const raw = store?.getItem(storageKey(game));
    const p = raw ? (JSON.parse(raw) as Profile) : null;
    if (p && p.v === 1 && p.game === game && Array.isArray(p.matches) && p.gauntlet && p.puzzles) return p;
  } catch { /* storage blocked or corrupt: a fresh profile */ }
  return emptyProfile(game);
}

export function saveProfile(store: Store | null, profile: Profile): void {
  try { store?.setItem(storageKey(profile.game), JSON.stringify(profile)); } catch { /* private mode or full: keep playing */ }
}

/** A new profile with the match added, newest first, history capped; oversized replay codes are dropped. */
export function addMatch(profile: Profile, entry: MatchEntry): Profile {
  const e = entry.replay && entry.replay.length > MAX_REPLAY ? { ...entry, replay: undefined } : entry;
  return { ...profile, matches: [e, ...profile.matches].slice(0, MAX_MATCHES) };
}

export interface Summary {
  played: number;
  wins: number;
  losses: number;
  draws: number;
  /** 0-1, or 0 with no decided matches. */
  winRate: number;
  /** Current run of wins (consecutive, newest first). */
  streak: number;
  bestStreak: number;
  byChampion: Array<{ champion: string; played: number; wins: number }>;
  byMode: Record<MatchMode, { played: number; wins: number }>;
  puzzleStreak: number;
}

/** Days are UTC calendar dates, so a daily puzzle is the same puzzle for every player at once. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const prevDay = (date: string): string => utcDate(Date.parse(`${date}T00:00:00Z`) - 86_400_000);

export function summarize(profile: Profile, now = Date.now()): Summary {
  const ms = profile.matches;
  const wins = ms.filter((m) => m.result === 'win').length, losses = ms.filter((m) => m.result === 'loss').length;
  let streak = 0;
  for (const m of ms) { if (m.result !== 'win') break; streak++; }
  let best = 0, run = 0;
  for (const m of [...ms].reverse()) { run = m.result === 'win' ? run + 1 : 0; best = Math.max(best, run); }
  const champs = new Map<string, { played: number; wins: number }>();
  for (const m of ms) if (m.champion) { const c = champs.get(m.champion) ?? { played: 0, wins: 0 }; c.played++; if (m.result === 'win') c.wins++; champs.set(m.champion, c); }
  const byMode = { practice: { played: 0, wins: 0 }, relay: { played: 0, wins: 0 }, gauntlet: { played: 0, wins: 0 }, puzzle: { played: 0, wins: 0 } };
  for (const m of ms) { byMode[m.mode].played++; if (m.result === 'win') byMode[m.mode].wins++; }
  // The puzzle streak counts back from today, or from yesterday if today's isn't solved yet.
  let day = profile.puzzles[utcDate(now)] ? utcDate(now) : prevDay(utcDate(now));
  let puzzleStreak = 0;
  while (profile.puzzles[day]) { puzzleStreak++; day = prevDay(day); }
  return {
    played: ms.length, wins, losses, draws: ms.length - wins - losses,
    winRate: wins + losses ? wins / (wins + losses) : 0,
    streak, bestStreak: best,
    byChampion: [...champs.entries()].map(([champion, c]) => ({ champion, ...c })).sort((a, b) => b.played - a.played || b.wins - a.wins),
    byMode, puzzleStreak,
  };
}
