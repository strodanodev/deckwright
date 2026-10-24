/**
 * Scaffold a new game config from the starter template.
 *
 *   tessaract new <game-id> [--title "My Duel"] [--out games]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { GameConfig } from '../core/types';
import { die, flag, parseArgs } from './common';
import { pkgPath } from './paths';

const args = parseArgs();
const id = args._[0] ?? die('usage: tessaract new <game-id> [--title "My Duel"] [--out games]');
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`game id must be kebab-case (got "${id}")`);
const template = JSON.parse(readFileSync(pkgPath('templates', 'starter.game.json'), 'utf8')) as GameConfig;

const title = flag(args, 'title') ?? id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const game: GameConfig = { ...template, title, litnode: { ...template.litnode, rulesetId: `${id}.v1` } };

const outDir = resolve(flag(args, 'out') ?? 'games');
const file = join(outDir, `${id}.game.json`);
if (existsSync(file)) die(`${file} already exists`);
mkdirSync(outDir, { recursive: true });
writeFileSync(file, `${JSON.stringify(game, null, 2)}\n`);
console.log(`created ${file}`);
console.log(`next: edit it, then: tessaract sim ${file}`);
