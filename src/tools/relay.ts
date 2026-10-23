/**
 * The per-match server a LitNode host spawns for this title (node/gauntlet.js "gauntlet").
 *
 * The node places the match, mints one HMAC join ticket per placed player and proxies
 * wss://<wsAddr>/<room> to this process. This server seats the two players, sequences their
 * actions into the input log (one entry per accepted action), enforces the turn clock, asks both
 * players to sign the log at the end and posts the signed ledger to the node's /ledger. The node
 * and three witnesses then replay that log through the pinned ruleset; nothing this server says
 * about the result counts.
 *
 * Zero dependencies (a minimal RFC 6455 text-frame server), so a node operator needs only this
 * checkout and Node. Gauntlet config: see templates/gauntlet.json.
 *
 * Dev mode (TCG_DEV=1, no LitNode): no tickets, players name themselves in `hello`, no ledger post.
 *   TCG_DEV=1 TCG_GAME=games/my-duel.game.json deckwright relay
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { concede, decode, endTurn, Op } from '../core/actions';
import { compileGame } from '../core/game';
import { createRules } from '../core/rules';
import type { AgentStats, GameConfig, MatchState } from '../core/types';

const env = process.env;
const DEV = env.TCG_DEV === '1';
const game = JSON.parse(readFileSync(env.TCG_GAME ?? 'games/rapture-duel.game.json', 'utf8')) as GameConfig;
const rules = createRules(compileGame(game));
const PORT = Number(env.GAUNTLET_PORT ?? env.PORT ?? 7830);
const SECRET = env.GAUNTLET_SECRET ?? '';
const MATCH_ID = env.GAUNTLET_MATCH_ID ?? (DEV ? randomBytes(32).toString('hex') : '');
const SEED = env.GAUNTLET_SEED ?? createHash('sha256').update(`seed\0${MATCH_ID}`).digest('hex');
const NODE_URL = env.GAUNTLET_NODE_URL ?? '';
const BUILD = env.GAUNTLET_BUILD || null;
const MODE = env.GAUNTLET_PLACED_MODE ?? 'casual';
const TURN_MS = Number(env.TCG_TURN_MS ?? 60_000);
const DECK_MS = Number(env.TCG_DECK_MS ?? 90_000);
const DISCONNECT_MS = Number(env.TCG_DISCONNECT_MS ?? 30_000);
const SIGN_MS = Number(env.TCG_SIGN_MS ?? 60_000);
const seats: Array<{ sub: string }> = env.GAUNTLET_SEATS ? JSON.parse(env.GAUNTLET_SEATS) : [];
if (!DEV && (!SECRET || seats.length !== 2 || !MATCH_ID)) throw new Error('gauntlet env missing: GAUNTLET_SECRET, GAUNTLET_SEATS (2 seats), GAUNTLET_MATCH_ID');

const log = (msg: string): void => console.log(`[tcg ${MATCH_ID.slice(0, 8)}] ${msg}`);

// ------------------------------------------------------------------ websocket

interface Peer {
  send(msg: unknown): void;
  close(): void;
}

function accept(req: IncomingMessage, socket: Duplex, onText: (s: string) => void, onClose: () => void): Peer {
  const key = req.headers['sec-websocket-key'];
  const digest = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
  const frame = (op: number, body: Buffer): Buffer => {
    const n = body.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
    return Buffer.concat([head, body]);
  };
  let buf = Buffer.alloc(0);
  let closed = false;
  const close = (): void => { if (closed) return; closed = true; try { socket.end(frame(8, Buffer.from([0x03, 0xe8]))); } catch { /* gone */ } onClose(); };
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return close();
      const maskAt = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      const body = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < body.length; i++) body[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 1) onText(body.toString('utf8'));
      else if (op === 8) return close();
      else if (op === 9) socket.write(frame(10, body));
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => socket.destroy());
  return { send: (msg) => { if (!closed) socket.write(frame(1, Buffer.from(JSON.stringify(msg)))); }, close };
}

// ------------------------------------------------------------------ tickets

/** node/gauntlet.js mintTicket: base64url(claims JSON) '.' base64url(HMAC-SHA256(payload, secret)). */
function verifyTicket(ticket: unknown): { sub: string; matchId: string; exp: number } | null {
  if (typeof ticket !== 'string') return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const want = Buffer.from(createHmac('sha256', SECRET).update(payload).digest('base64url'));
  const got = Buffer.from(ticket.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.matchId === MATCH_ID && claims.exp > Date.now() ? claims : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ match

interface Seat {
  id: string;
  peer: Peer | null;
  tokenId: string | null;
  stats: AgentStats;
  sig: string | null;
  goneAt: number | null;
}

const ZERO: AgentStats = { strength: 0, agility: 0, resilience: 0, intelligence: 0 }; // what LitNode hydrates for an `external` agent
const table: Seat[] = (DEV ? [] : seats.map((s) => s.sub)).map((id) => ({ id, peer: null, tokenId: null, stats: ZERO, sig: null, goneAt: null }));
const entries: Array<{ k: number; inputs: [number, number] }> = [];
let state: MatchState | null = null;
let turnTimer: ReturnType<typeof setTimeout> | null = null;
let ended = false;

const broadcast = (msg: unknown): void => { for (const s of table) s.peer?.send(msg); };
const ctx = (): { agents: Record<string, { stats: AgentStats }> } => ({ agents: Object.fromEntries(table.map((s) => [s.id, { stats: s.stats }])) });
const startMsg = (): unknown => ({ t: 'start', matchId: MATCH_ID, rulesetId: game.litnode.rulesetId, buildHash: BUILD, seed: SEED, participants: table.map((s) => s.id), champions: Object.fromEntries(table.map((s) => [s.id, { tokenId: s.tokenId, stats: s.stats }])), entries });

function record(side: 0 | 1, x: number): void {
  if (!state || state.over) return;
  const inputs: [number, number] = side === 0 ? [x, 0] : [0, x];
  const entry = { k: entries.length, inputs };
  entries.push(entry);
  state = rules.step(state, { [table[0].id]: inputs[0], [table[1].id]: inputs[1] });
  broadcast({ t: 'entry', entry });
  armTurnClock();
  if (rules.done(state)) void finish();
}

function armTurnClock(): void {
  if (state?.phase === 'decks' && turnTimer) return; // one deadline for the whole deck phase
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  if (!state || state.over) return;
  const side = state.turn;
  // An idle player's turn ends for them; the entry carries their END, and both players sign the log.
  if (state.phase === 'decks') {
    // A player who has not finished declaring by the deadline plays the rest of the suggested deck.
    turnTimer = setTimeout(() => {
      for (const s of [0, 1] as const) for (let x = rules.suggestedDeclaration(state!, s); x && state?.phase === 'decks'; x = rules.suggestedDeclaration(state!, s)) record(s, x);
    }, DECK_MS);
    return;
  }
  turnTimer = setTimeout(() => record(side, endTurn()), TURN_MS);
}

function maybeStart(): void {
  if (state || table.length !== 2 || table.some((s) => !s.peer)) return;
  state = rules.init(SEED, table.map((s) => s.id), ctx());
  log(`start: ${table.map((s) => s.id.slice(0, 8)).join(' vs ')}`);
  broadcast(startMsg());
  armTurnClock();
}

async function finish(): Promise<void> {
  if (ended) return;
  ended = true;
  if (turnTimer) clearTimeout(turnTimer);
  broadcast({ t: 'sign', matchId: MATCH_ID, buildHash: BUILD, ticks: entries.length });
  const t0 = Date.now();
  while (Date.now() - t0 < SIGN_MS && table.some((s) => !s.sig && s.peer)) await new Promise((r) => setTimeout(r, 250));
  if (DEV || !NODE_URL) { broadcast({ t: 'settled', delta: null, dev: true }); log('dev: not settling'); return; }
  const signatures = Object.fromEntries(table.filter((s) => s.sig).map((s) => [s.id, s.sig]));
  const agents = Object.fromEntries(table.filter((s) => s.tokenId).map((s) => [s.id, { tokenId: s.tokenId }]));
  const submission = { matchId: MATCH_ID, rulesetId: game.litnode.rulesetId, buildHash: BUILD, mode: MODE, participants: table.map((s) => s.id), entries, signatures, ...(Object.keys(agents).length ? { hydration: { agents } } : {}) };
  try {
    const r = await fetch(`${NODE_URL.replace(/\/+$/, '')}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
    const delta = await r.json();
    log(`ledger ${r.status}: ${r.ok ? 'settled' : delta.error}`);
    broadcast(r.ok ? { t: 'settled', delta } : { t: 'error', message: delta.error ?? `ledger ${r.status}` });
  } catch (e) {
    broadcast({ t: 'error', message: `ledger: ${(e as Error).message}` });
  }
  setTimeout(() => process.exit(0), 5000).unref();
}

function onMessage(seat: Seat | null, peer: Peer, raw: string, bind: (s: Seat) => void): void {
  let m: { t?: string; ticket?: string; player?: string; champion?: { tokenId?: string; stats?: AgentStats }; x?: number; sig?: string };
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'hello') {
    const id = DEV ? String(m.player ?? '') : verifyTicket(m.ticket)?.sub;
    let s = table.find((x) => x.id === id);
    if (!s && DEV && id && table.length < 2 && !state) { s = { id, peer: null, tokenId: null, stats: ZERO, sig: null, goneAt: null }; table.push(s); }
    if (!id || !s) { peer.send({ t: 'error', message: 'not a seat in this match' }); peer.close(); return; }
    s.peer?.close();
    s.peer = peer; s.goneAt = null;
    // The node re-reads the champion from the registry at settlement; this claim only lets both clients render the same start.
    if (!state && m.champion?.tokenId) { s.tokenId = String(m.champion.tokenId); s.stats = m.champion.stats ?? ZERO; }
    bind(s);
    peer.send({ t: 'seated', you: s.id, waiting: table.filter((x) => !x.peer).length + (2 - table.length) });
    if (state) peer.send(startMsg()); else maybeStart();
    return;
  }
  if (!seat || !state) return;
  const side = table.indexOf(seat) as 0 | 1;
  if (m.t === 'act' && Number.isInteger(m.x)) {
    const x = (m.x as number) | 0;
    const op = decode(x).op;
    // isLegal with a side: declarations from either side in the deck phase, the side to act afterwards.
    if (op === Op.Concede || rules.isLegal(state, x, side)) record(side, op === Op.Concede ? concede() : x);
    else peer.send({ t: 'reject', x, reason: state.turn === side ? 'illegal' : 'not your turn' });
  } else if (m.t === 'sig' && typeof m.sig === 'string' && /^[0-9a-f]{128}$/.test(m.sig)) {
    seat.sig = m.sig;
  }
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ game: game.litnode.rulesetId, matchId: MATCH_ID, seated: table.filter((s) => s.peer).length, entries: entries.length, over: state?.over ?? false }));
});
server.on('upgrade', (req, socket) => {
  let seat: Seat | null = null;
  const peer = accept(req, socket, (text) => onMessage(seat, peer, text, (s) => { seat = s; }), () => {
    if (!seat || seat.peer !== peer) return;
    seat.peer = null; seat.goneAt = Date.now();
    const gone = seat;
    // A player who stays away concedes, so the match can still settle.
    setTimeout(() => { if (!gone.peer && state && !state.over) record(table.indexOf(gone) as 0 | 1, concede()); }, DISCONNECT_MS).unref();
  });
});
server.listen(PORT, '127.0.0.1', () => log(`${game.litnode.rulesetId} on :${PORT}${DEV ? ' (dev)' : ''}`));
setTimeout(() => process.exit(0), Number(env.TCG_TTL_MS ?? 30 * 60_000)).unref();
