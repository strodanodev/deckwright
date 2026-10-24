// Bundle src/cli.ts and the tools into dist/ (plain ESM for Node, no tsx needed at run time), so
// `npx tessaract ...` works from a package, a tarball or a GitHub install. esbuild stays a runtime
// dependency: `title` and `web` bundle the game's rules on the builder's machine.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(at('../dist/'), { recursive: true, force: true });
await build({
  entryPoints: [at('../src/cli.ts')],
  outdir: at('../dist/'),
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22',
  external: ['esbuild'], banner: { js: '#!/usr/bin/env node' }, logLevel: 'warning',
});
console.log('built dist/cli.js');
