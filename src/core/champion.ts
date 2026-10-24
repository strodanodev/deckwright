import type { AgentStats } from './types';

/**
 * The one way every Tessaract surface turns a champion into stats: the rules, practice, the relay, the sim
 * and the LitNode ruleset. It mirrors LitNode's `normalize` (protocol/erc6699.js): each stat is rounded and
 * clamped to uint16, and a missing stat is 0. A player with no champion is an `external` agent to LitNode,
 * which hydrates all four stats as 0, so "no champion" means zeros here too, never a neutral midpoint.
 * Genre-agnostic: the kernel's Rapture adapter layer.
 */
export const NO_CHAMPION: Required<AgentStats> = Object.freeze({ strength: 0, agility: 0, resilience: 0, intelligence: 0 });

export function normalizeStats(raw?: Partial<Record<keyof AgentStats, unknown>> | null): Required<AgentStats> {
  const clamp = (v: unknown): number => Math.max(0, Math.min(65535, Math.round(Number(v) || 0)));
  if (!raw) return { ...NO_CHAMPION };
  return { strength: clamp(raw.strength), agility: clamp(raw.agility), resilience: clamp(raw.resilience), intelligence: clamp(raw.intelligence) };
}

/** A collection snapshot's CoreStats (`{ str, agi, res, int }`, as `tessaract snapshot` stores them) as AgentStats. */
export const statsFromCore = (s?: { str?: number; agi?: number; res?: number; int?: number } | null): Required<AgentStats> =>
  normalizeStats(s ? { strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int } : null);
