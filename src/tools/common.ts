/** Shared helpers for the Node-side TCG tools (run with `pnpm exec tsx`). Not imported by the game. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateGame } from '../core/game';
import type { GameConfig } from '../core/types';

export interface Args {
  _: string[];
  [flag: string]: string | boolean | string[];
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

export const flag = (args: Args, name: string): string | undefined => (typeof args[name] === 'string' ? (args[name] as string) : undefined);

export function readGame(path: string): GameConfig {
  const full = resolve(path);
  const cfg = JSON.parse(readFileSync(full, 'utf8')) as GameConfig;
  const errs = validateGame(cfg);
  if (errs.length) {
    console.error(`${full}: ${errs.length} problem(s)`);
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(1);
  }
  return cfg;
}

/** LitNode's `h(tag, ...parts)`: sha256 hex over `tag \0 part` (protocol/canonical.js). */
export const litnodeHash = (tag: string, ...parts: string[]): string => createHash('sha256').update(`${tag}\0${parts.join('\0')}`, 'utf8').digest('hex');

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
