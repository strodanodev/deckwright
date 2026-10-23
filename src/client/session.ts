import { concede, declare } from '../core/actions';
import { greedyBot } from '../core/bot';
import type { Rules } from '../core/rules';
import type { AgentStats, MatchState } from '../core/types';
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
  /** Champion each player brought, when known (relay sessions learn them at start). */
  readonly champions: Record<string, Champion | undefined>;
  onChange(cb: () => void): void;
  act(x: number): void;
  /** Declared-deck games: declare this deck (card indices). Sessions without a deck phase ignore it. */
  declareDeck(cards: number[]): void;
  concede(): void;
  close(): void;
}

export interface Champion { tokenId: string; stats: AgentStats }

type Entry = { k: number; inputs: number[] };

abstract class BaseSession implements MatchSession {
  public state: MatchState | null = null;
  public status = 'connecting…';
  public champions: Record<string, Champion | undefined> = {};
  protected readonly listeners: Array<() => void> = [];
  protected participants: string[] = [];
  protected readonly entries: Entry[] = [];

  protected constructor(public readonly rules: Rules, public you: string) {}

  public onChange(cb: () => void): void { this.listeners.push(cb); }
  protected changed(status?: string): void { if (status !== undefined) this.status = status; for (const cb of this.listeners) cb(); }

  protected begin(seed: string, participants: string[], stats: Record<string, AgentStats>): void {
    this.participants = participants;
    this.state = this.rules.init(seed, participants, { agents: Object.fromEntries(participants.map((p) => [p, { stats: stats[p] ?? {} }])) });
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

/** Offline: you against the greedy bot. Nothing is recorded or settled. */
export class LocalBotSession extends BaseSession {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly bot: (s: MatchState, side?: 0 | 1) => number;

  constructor(rules: Rules, seed = `${Date.now()}`, stats: AgentStats = {}, botStats: AgentStats = {}) {
    super(rules, 'you');
    this.bot = greedyBot(rules);
    this.begin(seed, ['you', 'bot'], { you: stats, bot: botStats });
    this.status = 'practice vs bot';
    this.botTurn();
  }

  /** Both decks go into the log at once: your cards on your side, the suggested deck on the bot's. */
  public declareDeck(cards: number[]): void {
    // Cards that are not legal (unknown, over maxCopies) are no-ops; the suggested deck fills any gap.
    for (let i = 0; this.state?.phase === 'decks' && i < 200; i++) {
      const mine = cards[i] !== undefined ? declare(cards[i]) : this.rules.suggestedDeclaration(this.state, 0);
      this.apply({ k: this.entries.length, inputs: [mine, this.bot(this.state, 1)] });
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

  /** Dev relay (TCG_DEV=1): no LitNode, players name themselves. */
  public static dev(rules: Rules, url: string, player: string, champion?: Champion): RelaySession {
    const s = new RelaySession(rules, player, null);
    s.open(url, { t: 'hello', player, champion });
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
    s.open(seat.ws, { t: 'hello', ticket: seat.ticket, champion });
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
      case 'seated':
        this.you = String(m.you);
        this.changed(Number(m.waiting) > 0 ? 'waiting for opponent…' : 'starting…');
        break;
      case 'start': {
        if (this.state) break;
        const champions = (m.champions ?? {}) as Record<string, { tokenId?: string | null; stats?: AgentStats }>;
        const participants = m.participants as string[];
        this.champions = Object.fromEntries(participants.map((p) => [p, champions[p]?.tokenId ? { tokenId: String(champions[p].tokenId), stats: champions[p].stats ?? {} } : undefined]));
        this.begin(String(m.seed), participants, Object.fromEntries(participants.map((p) => [p, champions[p]?.stats ?? {}])));
        for (const e of (m.entries as Entry[]) ?? []) this.apply(e);
        this.changed('live');
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
      case 'sign': {
        // Sign the log THIS client recorded; the arcade recomputes the head from it.
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

  public act(x: number): void { this.ws?.send(JSON.stringify({ t: 'act', x })); }

  private pendingDeck: number[] | null = null;
  /** Sends one declaration per card; before the match starts, they wait for it. */
  public declareDeck(cards: number[]): void {
    if (!this.state) { this.pendingDeck = cards; return; }
    if (this.state.phase === 'decks') for (const c of cards) this.act(declare(c));
  }
  public close(): void { this.ws?.close(); this.shell?.close(); }
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
  return new LocalBotSession(rules, `${Date.now()}`, champion?.stats);
}
