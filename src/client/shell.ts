/**
 * The LitNode arcade ("cabinet") around this game's iframe, over postMessage (cabinet/app.js).
 *
 * The player's ed25519 key never leaves the cabinet: it signs the seat challenge that gets this
 * player a join ticket, and the match ledger at the end. Given the game's own recorded `entries`,
 * the shell recomputes the chain head itself, so the game needs no hashing code.
 */

export interface LaunchParams {
  ws: string | null;
  room: string | null;
  player: string | null;
  matchId: string | null;
  buildHash: string | null;
  placed: boolean;
}

/** `?ws=<relay wss>&room=LIT-…&player=<key>&match=<matchId>&build=<buildHash>` (sdk/client.js parseLaunch). */
export function parseLaunch(search: string = globalThis.location?.search ?? ''): LaunchParams {
  const p = new URLSearchParams(search.replace(/^[^?]*\?/, ''));
  const get = (k: string): string | null => p.get(k) || null;
  const matchId = get('match');
  return { ws: get('ws'), room: get('room'), player: get('player'), matchId, buildHash: get('build'), placed: !!matchId };
}

export interface ShellInit {
  player: { id: string; guest?: boolean; name?: string };
  node: { url: string; online?: boolean };
  match?: { matchId: string; wsAddr?: string; participants?: string[]; mode?: string; buildHash?: string; rulesetId?: string };
  air?: { address?: string; tokenId?: string | null } | null;
}

export interface SeatChallenge { matchId: string; room: string; player: string; nonce: string }

export interface CabinetShell {
  init: ShellInit;
  signLedger(matchId: string, buildHash: string | null, entries: Array<{ k: number; inputs: number[] }>): Promise<string>;
  signSeat(challenge: SeatChallenge): Promise<string>;
  exit(): void;
  close(): void;
}

/** Resolves once the cabinet answers `cabinet:hello`; rejects outside an arcade iframe. */
export function connectShell(timeoutMs = 3000): Promise<CabinetShell> {
  const win = globalThis.window;
  if (!win?.parent || win.parent === win) return Promise.reject(new Error('not inside a LitNode arcade'));
  return new Promise((resolve, reject) => {
    const waiting = new Map<string, { ok: (sig: string) => void; fail: (e: Error) => void }>();
    const ask = (type: string, key: string, body: Record<string, unknown>): Promise<string> => new Promise((ok, fail) => {
      waiting.set(key, { ok, fail });
      win.parent.postMessage({ type, ...body }, '*');
      setTimeout(() => { if (waiting.delete(key)) fail(new Error(`${type}: the arcade did not answer`)); }, 15_000);
    });
    const settle = (key: string, d: { sig?: string; error?: string }): void => {
      const w = waiting.get(key);
      if (!w) return;
      waiting.delete(key);
      if (d.error || !d.sig) w.fail(new Error(d.error ?? 'no signature')); else w.ok(d.sig);
    };
    let shell: CabinetShell | null = null;
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== win.parent) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'cabinet:init' && !shell) {
        shell = {
          init: d as ShellInit,
          signLedger: (matchId, buildHash, entries) => ask('cabinet:sign', `ledger:${matchId}`, { body: { matchId, buildHash }, entries }),
          signSeat: (c) => ask('cabinet:sign-seat', `seat:${c.nonce}`, { challenge: c }),
          exit: () => win.parent.postMessage({ type: 'cabinet:exit' }, '*'),
          close: () => win.removeEventListener('message', onMessage),
        };
        resolve(shell);
      }
      if (d.type === 'cabinet:signed') settle(`ledger:${d.matchId}`, d);
      if (d.type === 'cabinet:seat-signed') settle(`seat:${d.nonce}`, d);
    };
    win.addEventListener('message', onMessage);
    win.parent.postMessage({ type: 'cabinet:hello' }, '*');
    setTimeout(() => { if (!shell) { win.removeEventListener('message', onMessage); reject(new Error('no cabinet:init: not launched from the arcade')); } }, timeoutMs);
  });
}
