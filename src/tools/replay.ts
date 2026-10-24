/**
 * Check a shared match: rebuild it from its record and print how it ended. A record replays to the same end on
 * every machine, so this settles "what happened in that match" without trusting anyone's screen.
 *
 *   tessaract replay <replay link | code | record.json> [--game <game.json>] [--out record.json]
 *
 * The game is found by the record's rulesetId among games/*.game.json unless --game names it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { checkRecord, decodeRecord, REPLAY_PARAM, replayStates } from '../client/replay';
import type { MatchRecord } from '../client/replay';
import { compileGame } from '../core/game';
import { createRules } from '../core/rules';
import type { GameConfig } from '../core/types';
import { die, flag, parseArgs, readGame } from './common';

const usage = 'usage: tessaract replay <replay link | code | record.json> [--game <game.json>] [--out record.json]';
const args = parseArgs();
const input = args._[0] ?? die(usage);

async function load(): Promise<MatchRecord> {
  if (existsSync(input)) return checkRecord(JSON.parse(readFileSync(input, 'utf8')));
  const code = new RegExp(`#${REPLAY_PARAM}=([A-Za-z0-9_-]+)`).exec(input)?.[1] ?? input;
  return decodeRecord(code);
}

function findGame(rulesetId: string): GameConfig {
  const named = flag(args, 'game');
  if (named) return readGame(named);
  const dir = resolve('games');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.game.json')) : [];
  for (const f of files) {
    const g = JSON.parse(readFileSync(join(dir, f), 'utf8')) as GameConfig;
    if (g.litnode?.rulesetId === rulesetId) return readGame(join(dir, f));
  }
  return die(`no game in ${dir} has rulesetId ${rulesetId}; pass --game <game.json>`);
}

const record = await load().catch((e: Error) => die(e.message));
const game = findGame(record.rulesetId);
const rules = createRules(compileGame(game));
const states = (() => { try { return replayStates(rules, record); } catch (e) { return die((e as Error).message); } })();
const end = states[states.length - 1];
const [a, b] = record.participants;
const who = (i: number): string => record.participants[i];
const result = !end.over ? 'unfinished' : end.winner === 2 ? 'draw' : `${who(end.winner)} won`;
console.log(`${game.title} (${record.rulesetId})`);
console.log(`  players     ${a} vs ${b}`);
for (const p of record.participants) {
  const ag = record.agents[p];
  console.log(`  ${p.slice(0, 10).padEnd(10)}  champion ${ag?.tokenId ?? 'none'} · str ${ag.stats.strength} agi ${ag.stats.agility} res ${ag.stats.resilience} int ${ag.stats.intelligence}`);
}
console.log(`  result      ${result} after ${end.turnNo} turns, ${states.length - 1} log entries`);
console.log(`  life        ${end.p.map((p) => `${p.id.slice(0, 10)} ${p.life}`).join(' · ')}`);
console.log(`  scores      ${JSON.stringify(rules.scores(end))}`);
// A fingerprint of the final state: two machines that replay the same record print the same digest.
console.log(`  state       sha256 ${createHash('sha256').update(JSON.stringify(rules.serialize(end))).digest('hex')}`);
if (states.length - 1 < record.entries.length) console.log(`  note        the match ended at entry ${states.length - 1}; ${record.entries.length - (states.length - 1)} later entries were ignored`);
const out = flag(args, 'out');
if (out) { writeFileSync(resolve(out), `${JSON.stringify(record, null, 2)}\n`); console.log(`  wrote       ${resolve(out)}`); }
