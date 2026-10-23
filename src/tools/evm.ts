/**
 * Just enough EVM for reading an NFT collection: a JSON-RPC client with backoff, call encoding for
 * the few selectors we use, ABI decoding of strings and static words, and tokenURI JSON parsing.
 * No dependencies; Node 22's fetch.
 */

export const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',
  tokenURI: '0xc87b56dd',
  ownerOf: '0x6352211e',
  coreStats: '0x09b97a4c', // ERC-6699 coreStats(uint256) -> (uint16 str, uint16 agi, uint16 res, uint16 int, uint32 level, uint64 xp)
  ownerOfKey: '0x1ef9fc77', // LitNode PlayerProfile ownerOfKey(bytes32) -> (address owner, uint256 profileId, bool active)
} as const;

/** Known chains, so a builder can write `--chain liteforge` instead of URLs and addresses. */
export const CHAINS: Record<string, { chainId: number; rpc: string; explorer: string; playerProfile?: string }> = {
  // PlayerProfile: LitNode v0.11.26 contracts/deployed.testnet.json.
  liteforge: { chainId: 4441, rpc: 'https://liteforge.rpc.caldera.xyz/http', explorer: 'https://liteforge.explorer.caldera.xyz', playerProfile: '0xe2cf46ab11eAfB18c1933409E35ae68CEce88882' },
};
export const chainById = (chainId: number): (typeof CHAINS)[string] | null => Object.values(CHAINS).find((c) => c.chainId === chainId) ?? null;
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

const word = (n: bigint): string => n.toString(16).padStart(64, '0');
export const encodeUintCall = (selector: string, value: bigint | string): string => `${selector}${word(BigInt(value))}`;

const strip = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);
export const words = (hex: string): bigint[] => {
  const h = strip(hex);
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt(`0x${h.slice(i, i + 64)}`));
  return out;
};

/** ABI-decode a single `string` return value. */
export function decodeString(hex: string): string {
  const h = strip(hex);
  if (h.length < 128) return '';
  const offset = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2;
  const len = Number(BigInt(`0x${h.slice(offset, offset + 64)}`));
  const bytes = h.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

export interface CoreStats { str: number; agi: number; res: number; int: number; level: number; xp: number }
export function decodeCoreStats(hex: string): CoreStats | null {
  const w = words(hex);
  if (w.length < 6) return null;
  const [str, agi, res, int, level, xp] = w.map((x) => Number(x));
  return { str, agi, res, int, level, xp };
}

/** A tokenURI's JSON: `data:application/json;base64,…`, `data:application/json,…`, ipfs:// or http(s). */
export async function readTokenJson(uri: string, gateway: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  const b64 = /^data:application\/json;base64,(.*)$/s.exec(uri);
  if (b64) return JSON.parse(Buffer.from(b64[1], 'base64').toString('utf8'));
  const plain = /^data:application\/json(?:;[^,]*)?,(.*)$/s.exec(uri);
  if (plain) return JSON.parse(decodeURIComponent(plain[1]));
  const url = toHttp(uri, gateway);
  if (!url) return null;
  const r = await fetchImpl(url);
  return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
}

/** ipfs://CID/path → <gateway>CID/path; http(s) unchanged; anything else null. */
export function toHttp(uri: string, gateway: string): string | null {
  if (/^https?:\/\//.test(uri)) return uri;
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/.exec(uri);
  return m ? `${gateway.replace(/\/+$/, '')}/${m[1]}` : null;
}

/** OpenSea-style `attributes: [{ trait_type, value }]` as a lookup (trait names compared case-insensitively). */
export function traitsOf(json: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = Array.isArray(json?.attributes) ? (json!.attributes as Array<{ trait_type?: unknown; value?: unknown }>) : [];
  for (const a of attrs) if (a && a.trait_type != null && a.value != null) out[String(a.trait_type).toLowerCase()] = String(a.value);
  return out;
}

// ------------------------------------------------------------------ JSON-RPC

export interface Rpc {
  call(to: string, data: string, block?: string): Promise<string>;
  request<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(message: string, public readonly code?: number, public readonly revert = false) { super(message); }
}

/** JSON-RPC over fetch, retrying rate limits and network errors with backoff (public RPCs throttle). */
export function createRpc(url: string, { retries = 10, fetchImpl = fetch }: { retries?: number; fetchImpl?: typeof fetch } = {}): Rpc {
  let id = 0;
  async function request<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        const text = await r.text();
        const throttled = r.status === 429 || /bandwidth|rate limit|too many/i.test(text);
        if (throttled || r.status >= 500) throw new RpcError(`rpc ${r.status}: ${text.slice(0, 120)}`, r.status);
        const j = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
        if (j.error) {
          const revert = j.error.code === 3 || /revert|execution reverted/i.test(j.error.message);
          throw new RpcError(j.error.message, j.error.code, revert);
        }
        return j.result as T;
      } catch (e) {
        const err = e as RpcError;
        // Retry only outages: network failures (no code) and HTTP throttling/5xx (code = HTTP status).
        // JSON-RPC errors (negative codes: reverts, block-range limits) are answers the caller handles.
        const outage = err.code === undefined || err.code >= 429;
        if (!outage || err.revert || attempt >= retries) throw e;
        await new Promise((res) => setTimeout(res, Math.min(30_000, 500 * 2 ** attempt)));
      }
    }
  }
  return {
    request,
    call: (to, data, block = 'latest') => request<string>('eth_call', [{ to, data }, block]),
  };
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
