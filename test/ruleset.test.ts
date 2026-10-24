import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { bundleRuleset, compatCheck } from '../src/tools/ruleset';

const games = readdirSync(new URL('./fixtures/', import.meta.url)).filter((f) => f.endsWith('.game.json'));
const paths = [fileURLToPath(new URL('../templates/starter.game.json', import.meta.url)), ...games.map((f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)))];

test('every game bundles into a LitNode-compatible ruleset', async () => {
  for (const p of paths) {
    const source = await bundleRuleset(p, 'test.v1');
    assert.deepEqual(await compatCheck(source), [], p);
  }
});

test('the compatibility check catches impure or broken rulesets', async () => {
  assert.ok((await compatCheck('export default { manifest: null }; const x = Math.random();')).some((f) => f.startsWith('purity')));
  assert.ok((await compatCheck("import x from 'y'; export default x;")).includes('artifact has imports'));
  assert.deepEqual(await compatCheck('export default {};'), ['manifest missing or malformed']);
});
