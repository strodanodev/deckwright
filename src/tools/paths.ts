/** Where the Deckwright package lives, whether running from source (tsx) or from the bundled CLI (dist/). */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'deckwright') return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('deckwright: cannot find the package root');
    dir = up;
  }
}

export const PKG_ROOT = findRoot();
export const pkgPath = (...parts: string[]): string => join(PKG_ROOT, ...parts);
export const PKG_VERSION = (JSON.parse(readFileSync(pkgPath('package.json'), 'utf8')) as { version: string }).version;
