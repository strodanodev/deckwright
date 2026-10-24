/**
 * Snapshot any ERC-721 collection from chain into the collection file `import` and `web` read:
 * every design's name, traits, image (downloaded, so the site serves it under its own CSP) and, when the
 * collection implements ERC-6699, its on-chain CoreStats.
 *
 *   tessaract snapshot <collection address> (--chain liteforge | --rpc <url> [--explorer <blockscout url>])
 *        [--out collection] [--tokens 1,2,3] [--from-block N] [--registry <ERC6699Registry>]
 *        [--gateway <ipfs gateway>] [--dedupe image|name|none] [--kind-trait Kind]
 *        [--element-trait Element] [--no-art]
 *
 * Which tokens: --tokens, else a Blockscout explorer's token-instance list (fast, metadata included), else
 * the collection's mint Transfer logs (any ERC-721, enumerable or not; slow on long chains, so pass
 * --from-block). Editions that share an image (pack copies of one design) are kept once (--dedupe image).
 * Writes <out>/cards.json and <out>/art/*.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { die, flag, parseArgs } from './common';
import { CHAINS, createRpc, decodeCoreStats, decodeString, encodeUintCall, pool, readTokenJson, RpcError, SEL, toHttp, traitsOf, TRANSFER_TOPIC, ZERO_TOPIC } from './evm';
import type { CoreStats } from './evm';

const args = parseArgs();
const address = (args._[0] ?? die('usage: tessaract snapshot <collection address> (--chain liteforge | --rpc <url>) [--out collection]')).toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(address)) die(`not an address: ${address}`);
const preset = flag(args, 'chain') ? CHAINS[flag(args, 'chain')!] ?? die(`unknown --chain (known: ${Object.keys(CHAINS).join(', ')})`) : null;
const rpcUrl = flag(args, 'rpc') ?? preset?.rpc ?? die('--rpc <url> or --chain <name> is required');
const explorer = (flag(args, 'explorer') ?? preset?.explorer ?? '').replace(/\/+$/, '') || null;
const outDir = resolve(flag(args, 'out') ?? 'collection');
// IPFS gateways, tried in order (some networks cannot resolve one or another).
const gateways = [flag(args, 'gateway'), 'https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/'].filter((g): g is string => !!g);
const gateway = gateways[0];
const dedupe = flag(args, 'dedupe') ?? 'image';
const kindTrait = (flag(args, 'kind-trait') ?? 'Kind').toLowerCase();
const elementTrait = (flag(args, 'element-trait') ?? 'Element').toLowerCase();
const registry = flag(args, 'registry')?.toLowerCase() ?? null;
const rpc = createRpc(rpcUrl);
const log = (msg: string): void => console.log(msg);
const hexBlock = (n: number): string => `0x${n.toString(16)}`;

interface Found { tokenId: string; json: Record<string, unknown> | null; uri: string }

// ------------------------------------------------------------------ which tokens
async function fromExplorer(): Promise<Found[] | null> {
  if (!explorer) return null;
  const out: Found[] = [];
  let more = '';
  for (let page = 0; page < 1000; page++) {
    const r = await fetch(`${explorer}/api/v2/tokens/${address}/instances${more}`);
    if (!r.ok) { log(`explorer answered ${r.status}; falling back to chain logs`); return null; }
    const j = (await r.json()) as { items?: Array<{ id?: string; metadata?: Record<string, unknown> | null }>; next_page_params?: Record<string, string> | null };
    for (const it of j.items ?? []) if (it.id != null) out.push({ tokenId: String(it.id), json: it.metadata ?? null, uri: '' });
    if (!j.next_page_params) break;
    more = `?${new URLSearchParams(j.next_page_params).toString()}`;
  }
  return out;
}

async function deployBlock(latest: number): Promise<number> {
  // Binary search for the first block with code at the address; a node without history answers 0.
  let lo = 0, hi = latest;
  try {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await rpc.request<string>('eth_getCode', [address, hexBlock(mid)]);
      if (code && code !== '0x') hi = mid; else lo = mid + 1;
    }
    return lo;
  } catch { return 0; }
}

async function fromLogs(): Promise<Found[]> {
  const latest = Number(BigInt(await rpc.request<string>('eth_blockNumber', [])));
  let from = flag(args, 'from-block') ? Number(flag(args, 'from-block')) : await deployBlock(latest);
  log(`scanning mint logs from block ${from} to ${latest}…`);
  const ids = new Set<string>();
  let span = 50_000;
  while (from <= latest) {
    const to = Math.min(latest, from + span - 1);
    try {
      const logs = await rpc.request<Array<{ topics: string[] }>>('eth_getLogs', [{ address, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [TRANSFER_TOPIC, ZERO_TOPIC] }]);
      for (const l of logs) if (l.topics.length === 4) ids.add(BigInt(l.topics[3]).toString());
      from = to + 1;
      span = Math.min(span * 2, 2_000_000);
    } catch (e) {
      if (!(e instanceof RpcError) || e.code === undefined || e.code >= 429 || span <= 100) throw e;
      span = Math.max(100, Math.floor(span / 4)); // the node caps the range or the result size: ask for less
    }
  }
  return [...ids].map((tokenId) => ({ tokenId, json: null, uri: '' }));
}

async function tokenJson(f: Found): Promise<Found> {
  if (f.json) return f;
  try {
    const uri = decodeString(await rpc.call(address, encodeUintCall(SEL.tokenURI, f.tokenId)));
    return { ...f, uri, json: uri ? await readTokenJson(uri, gateway) : null };
  } catch (e) {
    log(`  token ${f.tokenId}: no metadata (${(e as Error).message.slice(0, 80)})`);
    return f;
  }
}

async function statsOf(tokenId: string): Promise<CoreStats | null> {
  for (const target of [address, registry]) {
    if (!target) continue;
    try {
      const s = decodeCoreStats(await rpc.call(target, encodeUintCall(SEL.coreStats, tokenId)));
      if (s) return s;
    } catch (e) {
      // A revert means "not ERC-6699 here"; an outage must not silently become "no stats".
      if (!(e instanceof RpcError) || e.code === undefined || e.code >= 429) throw e;
    }
  }
  return null;
}

// ------------------------------------------------------------------ run
const callString = async (data: string): Promise<string> => { try { return decodeString(await rpc.call(address, data)); } catch { return ''; } };
// The explorer and the chain preset answer these without spending the (often throttled) public RPC.
const token = explorer ? ((await fetch(`${explorer}/api/v2/tokens/${address}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { name?: string; symbol?: string } | null) : null;
const chainId = preset?.chainId ?? Number(BigInt(await rpc.request<string>('eth_chainId', [])));
const name = token?.name ?? (await callString(SEL.name));
const symbol = token?.symbol ?? (await callString(SEL.symbol));
const listed = flag(args, 'tokens');
let found: Found[] = listed
  ? listed.split(',').map((s) => ({ tokenId: BigInt(s.trim()).toString(), json: null, uri: '' }))
  : (await fromExplorer()) ?? (await fromLogs());
if (!found.length) die('no tokens found (pass --tokens, --explorer or --from-block)');
found.sort((a, b) => (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
log(`${name || address} (${symbol || '?'}) on chain ${chainId}: ${found.length} token(s)`);
found = await pool(found, 4, tokenJson);
// A token whose metadata could not be read is skipped, not turned into a nameless card: it is usually an
// edition of a design another token already carries, or a throttled read worth retrying.
const unreadable = found.filter((f) => !f.json);
if (unreadable.length) {
  log(`  skipped ${unreadable.length} token(s) whose metadata could not be read (${unreadable.slice(0, 5).map((f) => f.tokenId).join(', ')}${unreadable.length > 5 ? ', …' : ''}); re-run later if designs are missing`);
  found = found.filter((f) => f.json);
  if (!found.length) die('no token metadata could be read');
}

const slug = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card';
const seen = new Set<string>();
const kept = found.filter(({ tokenId, json }) => {
  const key = dedupe === 'image' ? String(json?.image ?? tokenId) : dedupe === 'name' ? String(json?.name ?? tokenId) : tokenId;
  if (dedupe !== 'none' && seen.has(key)) return false;
  seen.add(key);
  return true;
});
if (kept.length < found.length) log(`  ${found.length - kept.length} edition(s) share a design with an earlier token: kept ${kept.length} (--dedupe ${dedupe})`);

const stats = await pool(kept, 4, (f) => statsOf(f.tokenId));
const cards = kept.map(({ tokenId, json, uri }, i) => {
  const traits = traitsOf(json);
  const nm = typeof json?.name === 'string' && json.name ? json.name : `${symbol || 'Token'} #${tokenId}`;
  const s = stats[i];
  return {
    tokenId, slug: slug(nm), name: nm, epithet: traits.epithet,
    kind: traits[kindTrait], element: traits[elementTrait] ?? 'Neutral', faction: traits.faction,
    stats: s ? { str: s.str, agi: s.agi, res: s.res, int: s.int } : null,
    image: typeof json?.image === 'string' ? json.image : '', metadata: uri && !uri.startsWith('data:') ? uri : null, art: null as string | null,
  };
});

if (!args['no-art']) {
  mkdirSync(join(outDir, 'art'), { recursive: true });
  const types: Record<string, string> = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg' };
  const fetchArt = async (image: string): Promise<{ r: Response; url: string }> => {
    let last: unknown = null;
    for (const g of /^ipfs:/.test(image) ? gateways : [gateway]) {
      const url = toHttp(image, g);
      if (!url) break;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (r.ok) return { r, url };
        last = new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      } catch (e) { last = e; }
    }
    throw last ?? new Error('no URL for the image');
  };
  await pool(cards, 4, async (c) => {
    if (!c.image) return;
    try {
      const { r, url } = await fetchArt(c.image);
      const ext = extname(new URL(url).pathname) || types[(r.headers.get('content-type') ?? '').split(';')[0]] || '.img';
      const file = `${c.slug}-${c.tokenId.slice(-8)}${ext}`;
      writeFileSync(join(outDir, 'art', file), Buffer.from(await r.arrayBuffer()));
      c.art = `./art/${file}`;
    } catch (e) { log(`  art for ${c.name}: ${(e as Error).message}`); }
  });
}

const withStats = cards.filter((c) => c.stats).length;
mkdirSync(outDir, { recursive: true });
const collection = { name: name || address, symbol, chainId, rpc: rpcUrl, address, explorer, erc6699: withStats > 0, snapshotAt: new Date().toISOString(), count: cards.length };
writeFileSync(join(outDir, 'cards.json'), `${JSON.stringify({ collection, cards }, null, 2)}\n`);
log(`wrote ${join(outDir, 'cards.json')}: ${cards.length} card(s), ${withStats} with ERC-6699 stats, ${cards.filter((c) => c.art).length} with art`);
if (!withStats) log('note: no ERC-6699 CoreStats found; champions will fight with base stats (all 0) (pass --registry if the agents live in a registry)');
