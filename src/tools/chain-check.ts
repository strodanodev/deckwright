/**
 * On-chain truth for the match server: a champion's ERC-6699 stats, and which tokens a player may field.
 * The relay uses it so both players play with the stats LitNode will settle with (never the stats a client
 * claims), and so owned-only matches accept only cards the player's wallet holds. Genre-agnostic: the
 * kernel's roster-declaration layer.
 *
 * A placed player's id is their LitNode player key (32-byte hex). LitNode's PlayerProfile binds that key to
 * the wallet that registered it, so the seat ticket alone proves the wallet: nobody signs anything extra.
 * This is the same binding LitNode's `mayPlay` checks before it settles with a registry champion.
 */
import { normalizeStats } from '../core/champion';
import type { AgentStats, GameConfig } from '../core/types';
import { chainById, createRpc, decodeCoreStats, encodeUintCall, pool, RpcError, SEL, words } from './evm';
import type { Rpc } from './evm';

export interface ChainCheck {
  /** The token's ERC-6699 CoreStats, normalized; null when the contract has none for it. */
  championStats(tokenId: string): Promise<Required<AgentStats> | null>;
  /** The collection token's owner (lowercase), or null for an unminted or unreadable token. */
  ownerOf(tokenId: string): Promise<string | null>;
  /** The wallet an ACTIVE PlayerProfile binds this player key to (lowercase), or null. */
  walletOf(playerKey: string): Promise<string | null>;
  /** Which of `tokenIds` the wallet owns. */
  holdings(wallet: string, tokenIds: string[]): Promise<Set<string>>;
}

export interface ChainCheckOptions {
  rpc: Rpc;
  /** The collection the game's cards come from (ownerOf). */
  collection: string;
  /** Where coreStats is read. Defaults to the collection; point it at the registry LitNode settles from. */
  statsContract?: string;
  /** LitNode PlayerProfile (ownerOfKey). Without it, no player key resolves to a wallet. */
  playerProfile?: string;
}

const lower = (a: string): string => a.toLowerCase();
const addressOf = (word: bigint): string => `0x${word.toString(16).padStart(40, '0')}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export function createChainCheck({ rpc, collection, statsContract = collection, playerProfile }: ChainCheckOptions): ChainCheck {
  // A revert (unknown token, no such function) is an answer; an outage after retries propagates.
  const read = async (to: string, data: string): Promise<string | null> => {
    try { return await rpc.call(to, data); } catch (e) { if (e instanceof RpcError && e.revert) return null; throw e; }
  };
  const ownerOf = async (tokenId: string): Promise<string | null> => {
    const r = await read(collection, encodeUintCall(SEL.ownerOf, tokenId));
    const w = r ? words(r) : [];
    const owner = w.length ? addressOf(w[0]) : null;
    return owner && owner !== ZERO_ADDRESS ? owner : null;
  };
  return {
    async championStats(tokenId) {
      const r = await read(statsContract, encodeUintCall(SEL.coreStats, tokenId));
      const s = r ? decodeCoreStats(r) : null;
      return s ? normalizeStats({ strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int }) : null;
    },
    ownerOf,
    async walletOf(playerKey) {
      const key = playerKey.replace(/^0x/, '').toLowerCase();
      if (!playerProfile || !/^[0-9a-f]{64}$/.test(key)) return null;
      const r = await read(playerProfile, `${SEL.ownerOfKey}${key}`);
      const w = r ? words(r) : [];
      // (address owner, uint256 profileId, bool active): profileId 0 means the key was never bound.
      return w.length >= 3 && w[1] !== 0n && w[2] === 1n ? addressOf(w[0]) : null;
    },
    async holdings(wallet, tokenIds) {
      const me = lower(wallet);
      const owners = await pool(tokenIds, 6, (id) => ownerOf(id));
      return new Set(tokenIds.filter((_, i) => owners[i] === me));
    },
  };
}

/** The NFT collection a game's cards were imported from: one address and chain, or null for a game without one. */
export function gameCollection(game: GameConfig): { address: string; chainId: number; tokenIds: string[] } | null {
  const tokens = game.cards.map((c) => c.token).filter((t): t is NonNullable<typeof t> => !!t);
  if (!tokens.length) return null;
  const addresses = new Set(tokens.map((t) => lower(t.collection)));
  if (addresses.size !== 1) throw new Error(`cards come from ${addresses.size} collections; set TCG_COLLECTION to the one to check`);
  return { address: [...addresses][0], chainId: tokens[0].chainId, tokenIds: [...new Set(tokens.map((t) => String(t.tokenId)))] };
}

/**
 * The relay's chain check from its environment, or null when there is nothing to check (no collection, or TCG_CHAIN=off).
 *   TCG_RPC             JSON-RPC URL (default: the preset for the cards' chain)
 *   TCG_COLLECTION      collection address (default: the one the cards were imported from)
 *   TCG_STATS_CONTRACT  where coreStats is read (default: the collection)
 *   TCG_PLAYER_PROFILE  LitNode PlayerProfile (default: the chain preset's)
 */
export function chainCheckFromEnv(game: GameConfig, env: NodeJS.ProcessEnv): ChainCheck | null {
  if (env.TCG_CHAIN === 'off') return null;
  const col = env.TCG_COLLECTION ? { address: lower(env.TCG_COLLECTION), chainId: 0 } : gameCollection(game);
  if (!col) return null;
  const preset = chainById(col.chainId);
  const url = env.TCG_RPC ?? preset?.rpc;
  if (!url) throw new Error(`no RPC for chain ${col.chainId}: set TCG_RPC (or TCG_CHAIN=off to skip on-chain checks)`);
  return createChainCheck({ rpc: createRpc(url, { retries: 4 }), collection: col.address, statsContract: env.TCG_STATS_CONTRACT, playerProfile: env.TCG_PLAYER_PROFILE ?? preset?.playerProfile });
}
