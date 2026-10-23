import { compileGame } from '../core/game';
import { createRules } from '../core/rules';
import type { AgentStats, GameConfig } from '../core/types';

/**
 * Turn a game config into a LitNode replayable title.
 *
 * The returned object has the exact shape LitNode's `defineTitle` (titles/title.js) produces, so the
 * bundled ruleset needs no LitNode import and passes `sdk/conformance.mjs` on its own. Build it with
 * `tools/build-title.ts`, which bundles this file, the core and the config into one import-free module.
 */
export function defineTcgTitle(config: GameConfig) {
  const rules = createRules(compileGame(config));
  const ln = config.litnode;
  // FNV-1a over the champion mapping: a retune of how ERC-6699 stats map is a new balance version.
  const source = JSON.stringify(config.champion);
  let hsh = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) { hsh ^= source.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193) >>> 0; }
  const balance = { version: `bal-${hsh.toString(16).padStart(8, '0')}`, apply: (stats?: AgentStats) => rules.champion(stats ?? {}) };

  return {
    manifest: {
      kind: 'replayable',
      rulesetId: ln.rulesetId,
      tickRate: ln.tickRate,
      maxTicks: ln.maxTicks,
      modes: ln.modes,
      participants: 2,
      inputSchema: 'tcg-action:op3,a4,target4|declare:op3,card15',
      // Open information: both clients and the public ledger can see decks and hands.
      hiddenInfo: false,
      replicas: 3,
      standingFloor: 0,
      hostPolicy: { affinity: 'open' },
      exclusive: false,
      display: { title: config.title, url: ln.url ?? null, description: config.description ?? null, cover: ln.cover ?? null, accent: ln.accent ?? null },
      balanceVersion: balance.version,
      services: {
        leaderboard: { kind: 'elo', k: ln.eloK },
        credits: null,
        stats: { track: ['matches', 'wins', 'ticks'] },
      },
    },
    balance,
    init: rules.init,
    step: rules.step,
    done: rules.done,
    scores: rules.scores,
    serialize: rules.serialize,
    view: rules.view,
  };
}
