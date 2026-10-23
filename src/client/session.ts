import { concede, declare } from '../core/actions';
import { type BotLevel, greedyBot } from '../core/bot';
import { normalizeStats } from '../core/champion';
import type { Rules } from '../core/rules';
import type { AgentStats, MatchState } from '../core/types';
import type { Puzzle } from '../meta/puzzle';
import { type MatchRecord, recordOf, replayStates } from './replay';
import { type CabinetShell, connectShell, parseLaunch } from './shell';

/**
 * A match the HUD can render and act in. Every session runs the same Rules locally and applies
 * the same log entries in the same order as the LitNode host and witnesses will on replay.
 */
export interface MatchSession {
  readonly rules: Rules;
  /** The local player's id (their LitNode player key in a placed match). */
  readonly you: string;
  readonly state: MatchState | null;
  /** Status line for the HUD: waiting, signing, settled, errors. */
  readonly status: string;
  /** Champion each player brought, when known (relay sessions learn them at start, with the stats read on chain). */
  readonly champions: Record<string, Champion | undefined>;
  /** Owned-only match: the server accepts only collection cards the player's wallet holds (support cards are free). */
  readonly ownedOnly: boolean;
  /** 'player' acts; 'spectator' watches a live match; 'replay' steps through a recorded one. Only players act. */
  readonly role: 'player' | 'spectator' | 'replay';
  /** The match so far as a replayable record (null before it starts): the share-link payload. */
  record(): MatchRecord | null;
  onChange(cb: () => void): void;
  act(x: number): void;
  /** Declared-deck games: declare this deck (card indices). Sessions without a deck phase ignore it. */
  declareDeck(cards: number[]): void;
  concede(): void;
  close(): void;
}

export interface Champion { tokenId: string; stats: AgentStats }
/** What a side brings to `init`: its champion's stats and token id (the token picks its hero power). */
export interface AgentClaim { stats?: AgentStats; tokenId?: string }

type Entry = { k: number; inputs: number[] };

abstract class BaseSession implements MatchSession {
  public state: MatchState | null = null;
  public status = 'connecting…';
  public champions: Record<string, Champion | undefined> = {};
  public ownedOnly = false;
  public role: MatchSession['role'] = 'player';
  protected readonly listeners: Array<() => void> = [];
  protected participants: string[] = [];
  protected readonly entries: Entry[] = [];
  private seed = '';
  private agents: MatchRecord['agents'] = {};

  protected constructor(public readonly rules: Rules, public you: string) {}

  public record(): MatchRecord | null { return this.state ? recordOf(this.rules, this.seed, this.participants, this.agents, this.entries) : null; }

  public onChange(cb: () => void): void { this.listeners.push(cb); }
  protected changed(status?: string): void { if (status !== undefined) this.status = status; for (const cb of this.listeners) cb(); }

  protected begin(seed: string, participants: string[], agents: Record<string, AgentClaim | undefined>): void {
    this.participants = participants;
    this.seed = seed;
    this.agents = Object.fromEntries(participants.map((p) => [p, { stats: normalizeStats(agents[p]?.stats), ...(agents[p]?.tokenId ? { tokenId: String(agents[p]!.tokenId) } : {}) }]));
    this.state = this.rules.init(seed, participants, { agents: this.agents });
  }

  protected apply(entry: Entry): void {
    if (!this.state || entry.k !== this.entries.length) return;
    this.entries.push(entry);
    this.state = this.rules.step(this.state, Object.fromEntries(this.participants.map((p, i) => [p, entry.inputs[i] ?? 0])));
  }

  public concede(): void { this.act(concede()); }
  public abstract act(x: number): void;
  public abstract declareDeck(cards: number[]): void;
  public abstract close(): void;
}

/** Options for an offline match: the bot's strength and, for declared-deck games, the deck it plays. */
export interface BotOptions { level?: BotLevel; foeDeck?: number[] }

/** Offline: you against the greedy bot. Nothing is settled; `record()` makes it replayable. */
export class LocalBotSession extends BaseSession {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly bot: (s: MatchState, side?: 0 | 1) => number;
  private readonly foeDeck: number[] | null;

  /** `you` / `foe`: each side's champion; omitted means no champion (every stat 0, as LitNode hydrates it). */
  constructor(rules: Rules, seed = `${Date.now()}`, you?: AgentClaim, foe?: AgentClaim, opts: BotOptions = {}) {
    super(rules, 'you');
    this.bot = greedyBot(rules, { level: opts.level });
    this.foeDeck = opts.foeDeck?.length ? opts.foeDeck : null;
    this.begin(seed, ['you', 'bot'], { you, bot: foe });
    this.status = 'practice vs bot';
    this.botTurn();
  }

  /** Both decks go into the log at once: your cards on your side, the bot's deck (or the suggested deck) on its side. */
  public declareDeck(cards: number[]): void {
    // Cards that are not legal (unknown, over maxCopies) are no-ops; the suggested deck fills any gap.
    for (let i = 0; this.state?.phase === 'decks' && i < 200; i++) {
      const mine = cards[i] !== undefined ? declare(cards[i]) : this.rules.suggestedDeclaration(this.state, 0);
      const foe = this.foeDeck?.[i] !== undefined ? declare(this.foeDeck[i]) : this.bot(this.state, 1);
      this.apply({ k: this.entries.length, inputs: [mine, foe] });
    }
    this.changed();
    this.botTurn();
  }

  public act(x: number): void {
    if (!this.state || this.state.over) return;
    const side = this.state.turn === 0 ? 0 : 1;
    if (this.participants[side] !== 'you' && (x & 7) !== 4) return;
    const mine = this.participants.indexOf('you');
    this.apply({ k: this.entries.length, inputs: mine === 0 ? [x, 0] : [0, x] });
    this.changed(this.state.over ? 'match over' : undefined);
    this.botTurn();
  }

  private botTurn(): void {
    const s = this.state;
    if (!s || s.over || s.phase === 'decks' || s.p[s.turn].id !== 'bot') return; // decks are declared together in declareDeck
    this.timer = setTimeout(() => {
      if (!this.state || this.state.over) return;
      const side = this.state.turn;
      const x = this.bot(this.state);
      this.apply({ k: this.entries.length, inputs: side === 0 ? [x, 0] : [0, x] });
      this.changed(this.state.over ? 'match over' : undefined);
      this.botTurn();
    }, 450);
  }

  public close(): void { if (this.timer) clearTimeout(this.timer); }
}

/**
 * Talks to `tools/relay.ts`, behind a LitNode host's gateway (placed match) or
 * standalone in dev mode. The server orders entries; this client only proposes actions.
 */
export class RelaySession extends BaseSession {
  private ws: WebSocket | null = null;

  private constructor(rules: Rules, you: string, private readonly shell: CabinetShell | null) { super(rules, you); }

  /**
   * Dev relay (TCG_DEV=1): no LitNode, players name themselves. Only the champion's token id is used: the
   * server reads its stats on chain. `wallet` (unproven in dev) is what an owned-only dev match checks.
   */
  public static dev(rules: Rules, url: string, player: string, champion?: Champion, wallet?: string): RelaySession {
    const s = new RelaySession(rules, player, null);
    s.open(url, { t: 'hello', player, champion: champion ? { tokenId: champion.tokenId } : undefined, wallet });
    return s;
  }

  /**
   * Watch a live match: no seat, no actions. The relay sends the log so far, then every entry (after its
   * spectator delay, if it has one). Works the same through a LitNode node's gateway (`wss://<wsAddr>/<room>`).
   */
  public static watch(rules: Rules, url: string): RelaySession {
    const s = new RelaySession(rules, '', null);
    s.role = 'spectator';
    s.status = 'joining as a spectator…';
    s.open(url, { t: 'watch' });
    return s;
  }

  /** A match the LitNode mesh placed: claim the seat with the arcade's signature, then join. */
  public static async placed(rules: Rules, champion?: Champion): Promise<RelaySession> {
    const launch = parseLaunch();
    const shell = await connectShell();
    const you = shell.init.player.id;
    const s = new RelaySession(rules, you, shell);
    const wsAddr = launch.ws ?? shell.init.match?.wsAddr ?? null;
    if (!wsAddr || !launch.room) throw new Error('no relay in the launch: open this game from the LitNode arcade');
    const base = `${wsAddr.replace(/^ws/, 'http').replace(/\/+$/, '')}/${launch.room}/ticket?player=${encodeURIComponent(you)}`;
    // First ask returns a one-time nonce (401); the second carries the player key's signature over it.
    const first = await fetch(base).then((r) => r.json()) as { challenge?: { matchId: string; room: string; player: string; nonce: string }; error?: string };
    if (!first.challenge) throw new Error(first.error ?? 'seat: no challenge');
    const sig = await shell.signSeat(first.challenge);
    const seat = await fetch(`${base}&nonce=${first.challenge.nonce}&sig=${sig}`).then((r) => r.json()) as { ticket?: string; ws?: string; error?: string };
    if (!seat.ticket || !seat.ws) throw new Error(seat.error ?? 'seat: no ticket');
    // The server proves the wallet from the player key's on-chain profile and reads the champion's stats itself.
    s.open(seat.ws, { t: 'hello', ticket: seat.ticket, champion: champion ? { tokenId: champion.tokenId } : undefined });
    return s;
  }

  private open(url: string, hello: Record<string, unknown>): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onclose = () => this.changed(this.state?.over ? this.status : 'disconnected');
    ws.onmessage = (ev) => { void this.onServer(JSON.parse(String(ev.data))); };
  }

  private async onServer(m: { t: string; [k: string]: unknown }): Promise<void> {
    switch (m.t) {
      case 'watching': {
        const delay = Number(m.delayMs) || 0;
        this.changed(`spectating${delay ? ` on a ${Math.round(delay / 1000)} s delay` : ''}: waiting for the match…`);
        break;
      }
      case 'seated':
        this.you = String(m.you);
        this.changed(Number(m.waiting) > 0 ? 'waiting for opponent…' : 'starting…');
        break;
      case 'start': {
        if (this.state) break;
        const champions = (m.champions ?? {}) as Record<string, { tokenId?: string | null; stats?: AgentStats }>;
        const participants = m.participants as string[];
        this.champions = Object.fromEntries(participants.map((p) => [p, champions[p]?.tokenId ? { tokenId: String(champions[p].tokenId), stats: champions[p].stats ?? {} } : undefined]));
        this.ownedOnly = m.ownedOnly === true;
        if (this.role === 'spectator') this.you = participants[0];
        this.begin(String(m.seed), participants, Object.fromEntries(participants.map((p) => [p, { stats: champions[p]?.stats, tokenId: champions[p]?.tokenId ?? undefined }])));
        for (const e of (m.entries as Entry[]) ?? []) this.apply(e);
        this.changed(this.role === 'spectator' ? (Number(m.delayMs) ? `watching on a ${Math.round(Number(m.delayMs) / 1000)} s delay` : 'watching live') : 'live');
        if (this.pendingDeck) { const d = this.pendingDeck; this.pendingDeck = null; this.declareDeck(d); }
        break;
      }
      case 'entry':
        this.apply(m.entry as Entry);
        this.changed();
        break;
      case 'reject':
        this.changed(`rejected: ${String(m.reason)}`);
        break;
      case 'notice':
        this.changed(String(m.message));
        break;
      case 'sign': {
        // Sign the log THIS client recorded; the arcade recomputes the head from it.
        if (this.role === 'spectator') { this.changed('match over'); break; }
        if (!this.shell) { this.changed('match over (dev: unsigned)'); break; }
        this.changed('signing the match ledger…');
        try {
          const sig = await this.shell.signLedger(String(m.matchId), (m.buildHash as string | null) ?? null, this.entries);
          this.ws?.send(JSON.stringify({ t: 'sig', sig }));
          this.changed('settling on LitNode…');
        } catch (e) { this.changed(`not signed: ${(e as Error).message}`); }
        break;
      }
      case 'settled': {
        const d = m.delta as { verification?: string; official?: boolean } | null;
        this.changed(d ? `settled${d.verification ? ` (${d.verification})` : ''}` : 'match over');
        break;
      }
      case 'error':
        this.changed(`error: ${String(m.message)}`);
        break;
    }
  }

  public act(x: number): void { if (this.role === 'player') this.ws?.send(JSON.stringify({ t: 'act', x })); }

  private pendingDeck: number[] | null = null;
  /** Sends one declaration per card; before the match starts, they wait for it. */
  public declareDeck(cards: number[]): void {
    if (!this.state) { this.pendingDeck = cards; return; }
    if (this.state.phase === 'decks') for (const c of cards) this.act(declare(c));
  }
  public close(): void { this.ws?.close(); this.shell?.close(); }
}

/**
 * Step through a recorded match: every state is rebuilt from the record with the same rules, so what you see is
 * exactly what was played (and what LitNode would settle). Read-only; `seek` moves through the log.
 */
export class ReplaySession implements MatchSession {
  public readonly role = 'replay' as const;
  public readonly ownedOnly = false;
  public readonly champions: Record<string, Champion | undefined>;
  public readonly states: MatchState[];
  /** Index of the first entry after the deck phase: where watching starts. */
  public readonly playStart: number;
  public you: string;
  public cursor: number;
  public status = 'replay';
  private readonly listeners: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(public readonly rules: Rules, private readonly rec: MatchRecord) {
    this.states = replayStates(rules, rec);
    this.champions = Object.fromEntries(rec.participants.map((p) => [p, rec.agents[p]?.tokenId ? { tokenId: rec.agents[p].tokenId!, stats: rec.agents[p].stats } : undefined]));
    this.you = rec.participants[0];
    this.playStart = Math.max(0, this.states.findIndex((s) => s.phase !== 'decks'));
    this.cursor = this.playStart;
  }

  public get state(): MatchState { return this.states[this.cursor]; }
  /** Entries in the log (the last state is `states[length]`). */
  public get length(): number { return this.states.length - 1; }
  public get playing(): boolean { return this.timer !== null; }
  public record(): MatchRecord { return this.rec; }
  public onChange(cb: () => void): void { this.listeners.push(cb); }
  private changed(): void { for (const cb of this.listeners) cb(); }

  public seek(k: number): void {
    const next = Math.max(0, Math.min(this.length, Math.round(k)));
    if (next === this.cursor) return;
    this.cursor = next;
    if (this.cursor >= this.length) this.pause();
    this.changed();
  }
  /** The entry where the turn containing `k` (or the next one, dir 1) starts. */
  public turnStart(k: number, dir: -1 | 1): number {
    const turnAt = (i: number): number => this.states[i].turnNo;
    if (dir > 0) { let i = k; while (i < this.length && turnAt(i) === turnAt(k)) i++; return i; }
    let i = k;
    if (i > this.playStart && turnAt(i - 1) !== turnAt(i)) i--; // already at a turn start: go to the previous one
    while (i > this.playStart && turnAt(i - 1) === turnAt(i)) i--;
    return i;
  }
  /** Flip which side is shown at the bottom. */
  public flip(): void { this.you = this.rec.participants[this.you === this.rec.participants[0] ? 1 : 0]; this.changed(); }
  public play(msPerEntry = 700): void {
    this.pause();
    if (this.cursor >= this.length) this.cursor = this.playStart;
    this.timer = setInterval(() => this.seek(this.cursor + 1), msPerEntry);
    this.changed();
  }
  public pause(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; this.changed(); } }

  public act(): void {}
  public declareDeck(): void {}
  public concede(): void {}
  public close(): void { this.pause(); }
}

/**
 * A daily puzzle: the match is rebuilt from the puzzle's log prefix, and you play the puzzle side's turn.
 * There is no opponent move: once your turn ends (or you win), `status` says solved or failed. `record()`
 * is the full log, so a solution is a replay anyone can verify.
 */
export class PuzzleSession extends BaseSession {
  /** The state at the start of the puzzle turn, for retries. */
  private readonly prefixLength: number;

  constructor(rules: Rules, public readonly puzzle: Puzzle) {
    super(rules, puzzle.participants[puzzle.side]);
    this.begin(puzzle.seed, puzzle.participants, puzzle.agents);
    for (const [a, b] of puzzle.prefix) this.apply({ k: this.entries.length, inputs: [a, b] });
    this.prefixLength = this.entries.length;
    this.status = 'puzzle';
  }

  /** Actions you have taken this attempt. */
  public get actions(): number { return this.entries.length - this.prefixLength; }

  public act(x: number): void {
    if (!this.state || this.state.over || this.state.turn !== this.puzzle.side) return;
    this.apply({ k: this.entries.length, inputs: this.puzzle.side === 0 ? [x, 0] : [0, x] });
    this.changed(this.state.over ? 'match over' : undefined);
  }

  /** Back to the start of the puzzle turn. */
  public retry(): void {
    this.entries.length = this.prefixLength;
    let s = this.rules.init(this.puzzle.seed, this.puzzle.participants, { agents: this.puzzle.agents });
    for (const [a, b] of this.puzzle.prefix) s = this.rules.step(s, { [this.puzzle.participants[0]]: a, [this.puzzle.participants[1]]: b });
    this.state = s;
    this.changed('puzzle');
  }

  public declareDeck(): void {}
  public close(): void {}
}

/**
 * Pick a session from the page URL: a placed LitNode match (`?match=`), a dev relay
 * (`?relay=ws://127.0.0.1:7830&name=alice`), or practice against the bot.
 */
export async function sessionFromUrl(rules: Rules, champion?: Champion): Promise<MatchSession> {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  if (q.get('match')) return RelaySession.placed(rules, champion);
  const relay = q.get('relay');
  if (relay) return RelaySession.dev(rules, relay, q.get('name') ?? `player-${Math.floor(Math.random() * 1e6)}`, champion);
  return new LocalBotSession(rules, `${Date.now()}`, champion);
}
