/**
 * Seeded xorshift32, the same generator as LitNode's `seededRandom` (sdk/index.js).
 * The seed is the placement's `h('seed', beacon, matchId)` hex string, so every node,
 * witness and client draws the same sequence. Never use Math.random in core code.
 */
export function seededRandom(seedHex: string): () => number {
  let s = 0;
  for (let i = 0; i < seedHex.length; i++) s = (Math.imul(s, 31) + seedHex.charCodeAt(i)) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** In-place Fisher–Yates shuffle driven by `rnd`. */
export function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1);
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
  return items;
}
