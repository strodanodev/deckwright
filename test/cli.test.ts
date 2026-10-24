import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = (...argv: string[]) => spawnSync(process.execPath, [tsx, join(ROOT, 'src', 'cli.ts'), ...argv], { encoding: 'utf8', cwd: ROOT });

test('help lists every command; unknown commands fail', () => {
  const help = cli('--help');
  assert.equal(help.status, 0);
  for (const c of ['create', 'new', 'snapshot', 'import', 'sim', 'title', 'web', 'dev', 'relay']) assert.match(help.stdout, new RegExp(`\\b${c}\\b`));
  assert.equal(cli('nope').status, 1);
});

test('create scaffolds a playable project with the skill and a built site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deckwright-'));
  try {
    const target = join(dir, 'Space Duel');
    const r = cli('create', target, '--title', 'Space Duel', '--sdk', 'file:../deckwright');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['games/space-duel.game.json', 'web/index.html', 'web/app.js', 'web/arena3d.js', 'web/ui/screens/match.js', 'web/styles/theme.css', 'web/lib/wallet.js', 'web/engine/deckwright.js', 'web/data/game.json', 'web/data/collection.json', 'vercel.json', 'gauntlet.json', '.claude/skills/deckwright/SKILL.md', 'README.md']) {
      assert.ok(existsSync(join(target, f)), f);
    }
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.deckwright, 'file:../deckwright');
    assert.equal(pkg.scripts.sim, 'deckwright sim games/space-duel.game.json --matches 300');
    const game = JSON.parse(readFileSync(join(target, 'games/space-duel.game.json'), 'utf8'));
    assert.equal(game.litnode.rulesetId, 'space-duel.v1');
    assert.equal(cli('create', target).status, 1, 'refuses a non-empty folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
