// Rebuild games/rapture-duel.game.json from the Rapture collection snapshot: the design-kit import of every card,
// plus the demo's own settings kept from the current file (title, description, litnode, element colours, rules,
// deck rules) and its champion life range. Art paths are kept from the current file too.
//
//   node scripts/build-rapture-duel.mjs <rapture cards.json>
//
// Then: pnpm sim games/rapture-duel.game.json --matches 1000 --decks mixed --strict, and bump litnode.rulesetId
// if anything changed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const snapshot = process.argv[2];
if (!snapshot) { console.error('usage: node scripts/build-rapture-duel.mjs <rapture cards.json>'); process.exit(1); }

const GAME = join(ROOT, 'games', 'rapture-duel.game.json');
const LIFE = { stat: 'resilience', min: 20, max: 26 };
const tmp = mkdtempSync(join(tmpdir(), 'rapture-duel-'));
try {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, join(ROOT, 'src', 'cli.ts'), 'import', snapshot, '--id', 'rapture-duel', '--out', tmp], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const kit = JSON.parse(readFileSync(join(tmp, 'rapture-duel.game.json'), 'utf8'));
  const cur = JSON.parse(readFileSync(GAME, 'utf8'));
  const game = {
    title: cur.title,
    description: cur.description,
    litnode: cur.litnode,
    elements: cur.elements,
    champion: { ...kit.champion, life: LIFE },
    rules: cur.rules,
    cards: kit.cards.map((c) => { const old = cur.cards.find((x) => x.id === c.id); return old?.art ? { ...c, art: old.art } : c; }),
    deck: kit.deck,
    deckRules: cur.deckRules,
  };
  writeFileSync(GAME, `${JSON.stringify(game, null, 2)}\n`);
  console.log(`rebuilt ${GAME} (${game.cards.length} cards, ${game.litnode.rulesetId})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
