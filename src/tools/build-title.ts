/**
 * Bundle a game config into the one-file LitNode ruleset every node pins by hash.
 *
 *   deckwright title <game.json> [--out rulesets] [--litnode <litnode dir>]
 *
 * Writes `<out>/<rulesetId>.js` (the artifact) and `<out>/<rulesetId>.json` (the sidecar a node reads)
 * and prints the buildHash. Given a LitNode folder (or LITNODE_HOME) it runs that folder's
 * `sdk/conformance.mjs`, the gate every node runs before it loads a ruleset; otherwise it runs the
 * built-in copy of those checks.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { die, flag, litnodeHash, parseArgs, readGame } from './common';
import { bundleRuleset, compatCheck } from './ruleset';

const args = parseArgs();
const gamePath = args._[0] ?? die('usage: deckwright title <game.json> [--out rulesets] [--litnode <dir>]');
const game = readGame(gamePath);
const outDir = resolve(flag(args, 'out') ?? 'rulesets');
const rid = game.litnode.rulesetId;

const source = await bundleRuleset(gamePath, rid);
const buildHash = litnodeHash('ruleset', source);
mkdirSync(outDir, { recursive: true });
const artifact = join(outDir, `${rid}.js`);
writeFileSync(artifact, source);
// Same fields as LitNode's rulesets/*.json; `publisher`/`sig` are filled in when a publisher key signs the build.
const sidecar = {
  rulesetId: rid, buildHash, bytes: Buffer.byteLength(source), kind: 'replayable',
  display: { title: game.title, url: game.litnode.url ?? null, description: game.description ?? null },
  builtAt: new Date().toISOString(), publisher: null, sig: null, signedAt: null,
};
writeFileSync(join(outDir, `${rid}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);

console.log(`ruleset   ${artifact} (${sidecar.bytes} bytes)`);
console.log(`buildHash ${buildHash}`);
console.log(`register  TitleRegistry.register("${rid}", 0x${buildHash})   then host with RULESETS=${artifact}`);

const litnode = flag(args, 'litnode') ?? process.env.LITNODE_HOME;
if (litnode) {
  const suite = join(resolve(litnode), 'sdk', 'conformance.mjs');
  if (!existsSync(suite)) die(`no LitNode conformance suite at ${suite}`);
  console.log(`\nLitNode conformance (${suite})`);
  const run = spawnSync(process.execPath, [suite, artifact], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

console.log('\nLitNode compatibility (built-in; pass --litnode <dir> for the real suite)');
const failures = await compatCheck(source);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(failures.length ? `${failures.length} compatibility problem(s)` : '  ok: single import-free module, pure, manifest, deterministic replay, scores, view');
process.exit(failures.length ? 1 : 0);
