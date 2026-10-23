import { normalizeStats } from '../core/champion';
import type { Rules } from '../core/rules';
import type { AgentStats, MatchState } from '../core/types';

/**
 * A finished (or in-progress) match as LitNode would replay it: the ruleset, the seed, the two players, the
 * champions they were hydrated with and the input log. Nothing else is needed to rebuild every state, so a
 * record is also proof of a result: anyone with the same ruleset reaches the same end. Genre-agnostic (the
 * kernel's esports layer): any title with `init`/`step` replays from it.
 */
export interface MatchRecord {
  v: 1;
  rulesetId: string;
  seed: string;
  participants: [string, string];
  /** What `init` received for each player: normalized stats, and the champion token when there was one. */
  agents: Record<string, { stats: Required<AgentStats>; tokenId?: string }>;
  /** The log: one `[side0, side1]` frame per entry. */
  entries: Array<[number, number]>;
}

/** Share links carry the record in the URL fragment (`#replay=…`), which browsers never send to a server. */
export const REPLAY_PARAM = 'replay';
/** Caps for records from untrusted links: compressed text, inflated JSON, and log length. */
const MAX_CODE = 64 * 1024, MAX_JSON = 1024 * 1024, MAX_ENTRIES = 5000;

const toBase64Url = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (code: string): Uint8Array => {
  const b = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) { await reader.cancel(); throw new Error('replay too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A record as a compact URL-safe string: deflated JSON, base64url. */
export async function encodeRecord(record: MatchRecord): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(record));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Parse and check a record from a share code. Everything in it is untrusted: shapes, sizes and stats are validated. */
export async function decodeRecord(code: string): Promise<MatchRecord> {
  if (code.length > MAX_CODE || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('not a replay code');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'), MAX_JSON)));
  } catch (e) { throw new Error(`not a replay code (${(e as Error).message})`); }
  return checkRecord(raw);
}

/** Validate a record's shape (for codes and for record files alike). */
export function checkRecord(raw: unknown): MatchRecord {
  const r = raw as Partial<MatchRecord> | null;
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
  if (!r || r.v !== 1 || !id(r.rulesetId) || typeof r.seed !== 'string' || r.seed.length > 256) throw new Error('not a Deckwright match record');
  const ps = r.participants;
  if (!Array.isArray(ps) || ps.length !== 2 || !ps.every(id) || ps[0] === ps[1]) throw new Error('a record needs two distinct participants');
  if (!Array.isArray(r.entries) || r.entries.length > MAX_ENTRIES) throw new Error('a record needs an input log');
  const entries = r.entries.map((e): [number, number] => {
    if (!Array.isArray(e) || e.length !== 2 || !e.every((x) => Number.isInteger(x))) throw new Error('every log entry is two integers');
    return [e[0] | 0, e[1] | 0];
  });
  const agents: MatchRecord['agents'] = {};
  for (const p of ps) {
    const a = (r.agents as Record<string, { stats?: AgentStats; tokenId?: unknown }> | undefined)?.[p];
    const tokenId = typeof a?.tokenId === 'string' && /^[0-9]{1,80}$/.test(a.tokenId) ? a.tokenId : undefined;
    agents[p] = { stats: normalizeStats(a?.stats), ...(tokenId ? { tokenId } : {}) };
  }
  return { v: 1, rulesetId: r.rulesetId, seed: r.seed, participants: [ps[0], ps[1]], agents, entries };
}

/**
 * Every state of a recorded match: `states[k]` is the state after k entries (`states[0]` is the opening).
 * Throws if the record is for another ruleset: different rules would replay to a different match.
 */
export function replayStates(rules: Rules, record: MatchRecord): MatchState[] {
  const want = rules.game.config.litnode.rulesetId;
  if (record.rulesetId !== want) throw new Error(`this replay is from ${record.rulesetId}; this site runs ${want}`);
  const [a, b] = record.participants;
  let s = rules.init(record.seed, record.participants, { agents: record.agents });
  const states = [s];
  for (const [x0, x1] of record.entries) {
    if (rules.done(s)) break;
    s = rules.step(s, { [a]: x0, [b]: x1 });
    states.push(s);
  }
  return states;
}

/** The record of a match a session played: what it passed `init` and every entry it applied. */
export function recordOf(rules: Rules, seed: string, participants: string[], agents: MatchRecord['agents'], entries: Array<{ inputs: number[] }>): MatchRecord {
  return {
    v: 1,
    rulesetId: rules.game.config.litnode.rulesetId,
    seed,
    participants: [participants[0], participants[1]],
    agents,
    entries: entries.map((e) => [e.inputs[0] ?? 0, e.inputs[1] ?? 0]),
  };
}
