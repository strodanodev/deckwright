// Deckwright (carried over from the FORGE hall) — just enough ABI for the PackShopV2 client: hex helpers, encoders (static words plus the uint[] / bytes[]
// arrays openPack takes), word/array decoders, the PackShopV2 log and view decoders and revert-data decoding.
// Dependency-free, and there is no keccak in the browser, so every function selector, event topic0 and error selector
// below is a hard-coded constant. web/test/abi.test.mjs proves each one equals ethers' value for the compiled
// PackShopV2 ABI (and that the encoders/decoders match ethers byte for byte).

export class AbiError extends Error {
  constructor(message) { super(message); this.name = "AbiError"; }
}

// ------------------------------------------------------------------ hex <-> bytes, quantities
/** True for a 0x-prefixed, even-length hex string (optionally of an exact byte length). */
export const isHex = (s, bytes) =>
  typeof s === "string" && s.length % 2 === 0 && /^0x[0-9a-fA-F]*$/.test(s) && (bytes == null || s.length === 2 + bytes * 2);
export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += HEX[b];
  return s;
}
export function hexToBytes(hex) {
  if (!isHex(hex)) throw new AbiError("not a 0x-prefixed, even-length hex string");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
/** UTF-8 text -> 0x hex (what personal_sign wants). */
export const utf8ToHex = (text) => bytesToHex(new TextEncoder().encode(text));

/** bigint | safe integer | decimal or 0x string -> bigint. Anything else throws (never silently coerces). */
export function toBigInt(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new AbiError(`not a safe integer: ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new AbiError(`cannot read ${typeof v === "string" ? JSON.stringify(v) : String(v)} as an integer`);
}
/** JSON-RPC quantity: minimal hex, no leading zeros ("0x0" for zero). */
export function toQuantity(v) {
  const n = toBigInt(v);
  if (n < 0n) throw new AbiError("a quantity cannot be negative");
  return "0x" + n.toString(16);
}
export function fromQuantity(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new AbiError(`not a hex quantity: ${String(hex)}`);
  return BigInt(hex);
}

// ------------------------------------------------------------------ encoding
// Static words (uint<N>, address, bool) plus the three dynamic shapes PackShopV2 takes: uint<N>[] (pack rounds, token
// ids), bytes and bytes[] (drand signatures). A dynamic argument is an offset in the head and its data in the tail.
export function encodeUint(v, bits = 256) {
  const n = toBigInt(v);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new AbiError(`${String(v)} does not fit in uint${bits}`);
  return n.toString(16).padStart(64, "0");
}
export function encodeAddress(a) {
  if (!isAddress(a)) throw new AbiError(`not an address: ${String(a)}`);
  return a.slice(2).toLowerCase().padStart(64, "0");
}
export function encodeBool(b) {
  if (typeof b !== "boolean") throw new AbiError("not a boolean");
  return (b ? "1" : "0").padStart(64, "0");
}
/** bytes: a 0x hex string or a Uint8Array -> length word + data right-padded to whole words. */
export function encodeBytes(v) {
  const hex = v instanceof Uint8Array ? bytesToHex(v) : v;
  if (!isHex(hex)) throw new AbiError("bytes must be 0x-prefixed, even-length hex or a Uint8Array");
  const n = (hex.length - 2) / 2;
  return encodeUint(n) + hex.slice(2).toLowerCase().padEnd(Math.ceil(n / 32) * 64, "0");
}
const isDynamic = (t) => t === "bytes" || t.endsWith("[]");
function encodeStatic(t, v) {
  if (t === "address") return encodeAddress(v);
  if (t === "bool") return encodeBool(v);
  const m = /^uint(\d*)$/.exec(t);
  if (m) return encodeUint(v, m[1] ? Number(m[1]) : 256);
  throw new AbiError(`unsupported type ${t}`);
}
function encodeDynamic(t, v) {
  if (t === "bytes") return encodeBytes(v);
  if (!Array.isArray(v)) throw new AbiError(`${t} needs an array`);
  const inner = t.slice(0, -2);
  return encodeUint(v.length) + encodeTuple(v.map(() => inner), v);
}
// heads first (a static value, or the byte offset of a dynamic one from the start of this tuple), then the tails
function encodeTuple(types, values) {
  const heads = [], tails = [];
  let offset = types.length * 32;
  types.forEach((t, i) => {
    if (!isDynamic(t)) { heads.push(encodeStatic(t, values[i])); return; }
    const tail = encodeDynamic(t, values[i]);
    heads.push(encodeUint(offset));
    tails.push(tail);
    offset += tail.length / 2;
  });
  return heads.join("") + tails.join("");
}
/** Concatenated ABI words (no 0x). types: "address" | "bool" | "uint<N>" | "uint<N>[]" | "bytes" | "bytes[]". */
export function encodeArgs(types, values) {
  if (types.length !== values.length) throw new AbiError("argument count does not match the type list");
  return encodeTuple(types, values);
}
/** Calldata: 4-byte selector (0x...) + encoded args. */
export function encodeCall(selector, types = [], values = []) {
  if (!isHex(selector, 4)) throw new AbiError("a selector is 4 bytes of 0x hex");
  return selector + encodeArgs(types, values);
}

// ------------------------------------------------------------------ decoding
/** Split ABI data into 32-byte words (64 hex chars each, no 0x). */
export function words(data) {
  if (!isHex(data)) throw new AbiError("malformed ABI data (not hex)");
  const h = data.slice(2);
  if (h.length % 64) throw new AbiError(`malformed ABI data (${h.length / 2} bytes is not a whole number of words)`);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
const word = (ws, i) => {
  if (!(i >= 0 && i < ws.length)) throw new AbiError("ABI data is too short");
  return ws[i];
};
export const wordToUint = (w) => BigInt("0x" + w);
export function wordToAddress(w) {
  if (!/^0{24}[0-9a-f]{40}$/i.test(w)) throw new AbiError("malformed address word");
  return "0x" + w.slice(24).toLowerCase();
}
export function wordToBool(w) {
  if (/^0{64}$/.test(w)) return false;
  if (/^0{63}1$/.test(w)) return true;
  throw new AbiError("malformed bool word");
}
/** Static values by word index of a decoded `words()` result. */
export const uintAt = (ws, i) => wordToUint(word(ws, i));
export const addressAt = (ws, i) => wordToAddress(word(ws, i));
export const boolAt = (ws, i) => wordToBool(word(ws, i));

/**
 * A dynamic uint array whose offset sits in head slot `headIndex` (event data and function results put dynamic
 * values behind an offset). Works for uint256[] and uint16[] alike, since ABI pads every element to a full word;
 * `bits` only bounds the values. Returns bigint[]. Bounds are checked, so hostile data cannot make it loop or throw
 * anything but AbiError.
 */
export function uintArrayAt(ws, headIndex, bits = 256, maxLen = 1024) {
  const offset = wordToUint(word(ws, headIndex));
  if (offset % 32n) throw new AbiError("array offset is not word aligned");
  const at = offset / 32n > BigInt(ws.length) ? ws.length : Number(offset / 32n); // clamp: word() then rejects it
  const len = wordToUint(word(ws, at));
  if (len > BigInt(maxLen)) throw new AbiError(`array of ${len} elements is longer than ${maxLen}`);
  const n = Number(len);
  if (at + 1 + n > ws.length) throw new AbiError("array runs past the end of the data");
  const max = (1n << BigInt(bits)) - 1n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = wordToUint(ws[at + 1 + i]);
    if (v > max) throw new AbiError(`array element does not fit in uint${bits}`);
    out.push(v);
  }
  return out;
}

/** A static uint word that must fit `bits` (uint64 rounds, uint8 enums): a wider value is hostile data, not a number. */
export function uintBoundAt(ws, i, bits) {
  const v = uintAt(ws, i);
  if (v >= 1n << BigInt(bits)) throw new AbiError(`word ${i} does not fit in uint${bits}`);
  return v;
}

// ------------------------------------------------------------------ PackShopV2 constants
// Verified against the compiled ABI by web/test/abi.test.mjs. Function names match the Solidity names.
export const SELECTORS = Object.freeze({
  buyPack: "0xc37b9bcd",          // buyPack()
  openPack: "0xd67af07d",         // openPack(uint256 packId, uint64[] rounds, bytes[] signatures)
  deal: "0xb1a75d37",             // deal(uint256 maxPacks, uint64[] rounds, bytes[] signatures) -> uint256 dealt
  refund: "0x278ecde1",           // refund(uint256): only after an owner shutdown, see the contract
  phaseOf: "0x9a243ebf",          // phaseOf(uint256) -> uint8 Phase
  packOf: "0xafac6b21",           // packOf(uint256) -> (buyer, uint64 round, uint8 phase, paid, uint16[] templateIds, uint8[] finishes)
  config: "0x79502c55",           // config() -> (price, packSize, dailyLimit, paused, ready, maxSupply, packsTotal, packsSold, cardsLeft, templateCount)
  packsLeftToday: "0x9d3a3ee5",   // packsLeftToday(address) -> uint256
  recentPacks: "0xd3ee9e8d",      // recentPacks(address,uint256) -> (uint256[] ids, uint8[] phases, uint64[] rounds)
  pendingRounds: "0x9e405606",    // pendingRounds(uint256 upTo, uint256 max) -> uint64[]
  finishesOf: "0xda57e0a3",       // finishesOf(uint256[]) -> uint8[]
  deckRemaining: "0xc434f97d",    // deckRemaining() -> uint16[3][5]
  deckInitial: "0x59881df0",      // deckInitial() -> uint16[3][5]
  shutdownAt: "0x5758e705",       // shutdownAt() -> uint64 (0 = never)
  tokensOf: "0xa2eb8927",         // tokensOf(uint256) -> uint256[] the token ids an Opened pack minted, slot order ([] until Opened)
  minter: "0x07546172",           // minter() -> address of the StudioMinter it mints through
});
/** StudioMinter, read to learn whether the shop can still mint (a dealt pack is refundable only once it cannot). */
export const MINTER_SELECTORS = Object.freeze({
  minters: "0xf46eccc4",          // minters(address) -> bool
});
export const TOPICS = Object.freeze({
  PackBought: "0xc7d6989ca2ffca2a02ac49726fddbda9fc22d35b1ba7ad2dadfad3499ea66c1a",   // (uint256 indexed,address indexed,uint256,uint64)
  PackDealt: "0x3bbe9c7903d9bc83782b4fe7917934b0e58e7e1e2a5c97613bfd0a537c34b580",    // (uint256 indexed,uint64,uint16[],uint8[])
  PackOpened: "0xe8fe1da6f4369c7dc6123f53ebe7bc59b4d3df2353ce8a427a2402034929d1a6",   // (uint256 indexed,address indexed,uint256[],uint16[],uint8[])
  PackRefunded: "0xc12715bc2bc409ada9f137a81e6d2fd088d140056431b45d123389d03ad4b0bf", // (uint256 indexed,address indexed,uint256)
});
/** Custom errors a player can meet: PackShopV2's own, OpenZeppelin's Pausable/ReentrancyGuard, and the card
 *  contracts PackShopV2 mints through (a misconfigured minter role or template surfaces as one of those). The beacon
 *  registry reverts with Error("Invalid signature"), which decodeRevert reads as a plain Error(string). */
export const ERROR_SELECTORS = Object.freeze({
  // PackShopV2
  NotLocked: "0x1834e265", IsShutdown: "0x361d247e", SoldOut: "0x52df9fe5", WrongPayment: "0x788a686f",
  DailyLimitReached: "0xf402e5b1", BadPack: "0xb6f1af1f", NotDealt: "0xba5bdd4e", BeaconMissing: "0x530cc202",
  BadProof: "0x7ca55c77", NotRefundable: "0x3742d1f6", TransferFailed: "0x90b8ec18",
  // OpenZeppelin
  EnforcedPause: "0xd93c0665", ReentrancyGuardReentrantCall: "0x3ee5aeb5",
  // StudioMinter / CardDesign / RaptureCards (StudioMinter's NotMinter() shares PackShopV2's selector)
  NotMinter: "0xf8d2906c", NotRegistered: "0xaba47339", BadTraits: "0x05cc5c09", BadParts: "0x2011b3c6",
  BadKit: "0x36ef3e93", EmptyBatch: "0xc2e5347d", AlreadyWritten: "0xd19dddcd", BadDesign: "0xaa3fa472",
  OutOfBand: "0x8d4ddc34",
});
export const ERROR_STRING = "0x08c379a0";   // Error(string)
export const PANIC = "0x4e487b71";          // Panic(uint256)
const ERROR_NAMES = Object.freeze(Object.fromEntries(Object.entries(ERROR_SELECTORS).map(([n, s]) => [s, n])));

// ------------------------------------------------------------------ PackShopV2 logs
// A log is the raw JSON-RPC object: { topics: [topic0, ...], data }. Indexed params live in the topics.
const topicUint = (t) => {
  if (!isHex(t, 32)) throw new AbiError("malformed topic");
  return BigInt(t);
};
const topicAddress = (t) => {
  if (!isHex(t, 32)) throw new AbiError("malformed topic");
  return wordToAddress(t.slice(2));
};
function check(log, name, indexed) {
  const t = log?.topics;
  if (!Array.isArray(t) || String(t[0]).toLowerCase() !== TOPICS[name] || t.length !== 1 + indexed) {
    throw new AbiError(`not a ${name} log`);
  }
  return words(log.data ?? "0x");
}
/** A pack's cards: templateIds (uint16[]) and finishes (uint8[]) behind head slots a and b, the same length. */
function cardsAt(ws, a, b) {
  const templateIds = uintArrayAt(ws, a, 16).map(Number);
  const finishes = uintArrayAt(ws, b, 8).map(Number);
  if (finishes.length !== templateIds.length) throw new AbiError("templateIds and finishes differ in length");
  return { templateIds, finishes };
}
/** PackBought(packId indexed, buyer indexed, paid, uint64 round) -> bigints (buyer lowercase address). */
export function decodePackBought(log) {
  const ws = check(log, "PackBought", 2);
  if (ws.length !== 2) throw new AbiError("PackBought data must be two words");
  return { packId: topicUint(log.topics[1]), buyer: topicAddress(log.topics[2]), paid: uintAt(ws, 0), round: uintBoundAt(ws, 1, 64) };
}
/** PackDealt(packId indexed, uint64 round, uint16[] templateIds, uint8[] finishes): the cards are fixed, not minted yet. */
export function decodePackDealt(log) {
  const ws = check(log, "PackDealt", 1);
  return { packId: topicUint(log.topics[1]), round: uintBoundAt(ws, 0, 64), ...cardsAt(ws, 1, 2) };
}
/** PackOpened(packId indexed, buyer indexed, uint256[] tokenIds, uint16[] templateIds, uint8[] finishes), slot by slot. */
export function decodePackOpened(log) {
  const ws = check(log, "PackOpened", 2);
  const tokenIds = uintArrayAt(ws, 0, 256);
  const cards = cardsAt(ws, 1, 2);
  if (cards.templateIds.length !== tokenIds.length) throw new AbiError("PackOpened arrays differ in length");
  return { packId: topicUint(log.topics[1]), buyer: topicAddress(log.topics[2]), tokenIds, ...cards };
}
/** PackRefunded(packId indexed, buyer indexed, amount). */
export function decodePackRefunded(log) {
  const ws = check(log, "PackRefunded", 2);
  if (ws.length !== 1) throw new AbiError("PackRefunded data must be one word");
  return { packId: topicUint(log.topics[1]), buyer: topicAddress(log.topics[2]), amount: uintAt(ws, 0) };
}

// ------------------------------------------------------------------ PackShopV2 views
/**
 * recentPacks(who, n) result: (uint256[] ids, uint8[] phases, uint64[] rounds), the buyer's newest packs, oldest
 * first. All three arrays are dynamic (three offsets, then three length-prefixed arrays). Returns
 * { ids: bigint[], phases: number[], rounds: bigint[] }, equal lengths or AbiError. maxLen bounds what a hostile
 * answer can make us allocate; the contract itself never returns more than 16.
 */
export function decodeRecentPacks(data, maxLen = 256) {
  const ws = words(data);
  const ids = uintArrayAt(ws, 0, 256, maxLen);
  const phases = uintArrayAt(ws, 1, 8, maxLen).map(Number);
  const rounds = uintArrayAt(ws, 2, 64, maxLen);
  if (phases.length !== ids.length || rounds.length !== ids.length) throw new AbiError("recentPacks arrays differ in length");
  return { ids, phases, rounds };
}
/** packOf(id) result -> { buyer, round (bigint), phase, paid (bigint), templateIds, finishes }. The cards are empty until dealt. */
export function decodePackOf(data) {
  const ws = words(data);
  return { buyer: addressAt(ws, 0), round: uintBoundAt(ws, 1, 64), phase: Number(uintBoundAt(ws, 2, 8)), paid: uintAt(ws, 3), ...cardsAt(ws, 4, 5) };
}
/** A function result that is one dynamic uint array (pendingRounds: uint64[], finishesOf: uint8[]) -> bigint[]. */
export const decodeUintArray = (data, bits = 256, maxLen = 1024) => uintArrayAt(words(data), 0, bits, maxLen);
/** deckInitial() / deckRemaining(): a static uint16[3][5], [kind][finish - 1], fifteen words row by row -> number[5][3]. */
export function decodeDeck(data) {
  const ws = words(data);
  if (ws.length !== 15) throw new AbiError(`a deck is 15 words, got ${ws.length}`);
  return Array.from({ length: 5 }, (_, k) => Array.from({ length: 3 }, (_, f) => Number(uintBoundAt(ws, k * 3 + f, 16))));
}

// ------------------------------------------------------------------ reverts
/**
 * Dig revert data (0x + at least a 4-byte selector) out of whatever error shape a JSON-RPC client, MetaMask,
 * Hardhat or ethers produced: geth puts it in error.data; MetaMask nests it (data.originalError.data, data.data);
 * Hardhat nests it under data.data. Returns null when the error carries none.
 */
export function extractRevertData(err, depth = 0) {
  if (err == null || depth > 5) return null;
  if (typeof err === "string") return isHex(err) && err.length >= 10 ? err : null;
  if (typeof err !== "object") return null;
  for (const key of ["data", "originalError", "error", "info", "cause"]) {
    const found = extractRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}
/**
 * Revert data -> { selector, name, reason?, code?, round? }. name is a known custom error, "Error" (with .reason),
 * "Panic" (with .code, a bigint), or null for a selector we do not know; BeaconMissing carries the drand .round it
 * needs (a bigint). Returns null when there is no data.
 */
export function decodeRevert(data) {
  if (!isHex(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING) {
    const out = { selector, name: "Error", reason: "" };
    try {
      const ws = words("0x" + data.slice(10));
      const at = Number(wordToUint(word(ws, 0)) / 32n);
      const len = Number(wordToUint(word(ws, at)));
      const hex = ws.slice(at + 1).join("").slice(0, len * 2);
      if (hex.length === len * 2) out.reason = new TextDecoder().decode(hexToBytes("0x" + hex));
    } catch { /* malformed reason string: keep the name, drop the text */ }
    return out;
  }
  if (selector === PANIC) {
    let code = null;
    try { code = uintAt(words("0x" + data.slice(10)), 0); } catch { /* keep null */ }
    return { selector, name: "Panic", code };
  }
  const name = ERROR_NAMES[selector] ?? null;
  if (name === "BeaconMissing") {
    let round = null;
    try { round = uintBoundAt(words("0x" + data.slice(10)), 0, 64); } catch { /* keep null */ }
    return { selector, name, round };
  }
  return { selector, name };
}
