/**
 * Bundling a game into a LitNode ruleset, and the built-in copy of LitNode's conformance checks.
 * Used by `build-title.ts` and the tests.
 */
import { dirname, relative, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { pkgPath } from './paths';

const titleModule = pkgPath('src', 'litnode', 'title.ts');

/** One import-free ES module: the config, the core and `defineTcgTitle`, default-exported. */
export async function bundleRuleset(gamePath: string, rulesetId: string): Promise<string> {
  const resolveDir = dirname(resolve(gamePath));
  const toImport = (p: string): string => { const r = relative(resolveDir, p).replace(/\\/g, '/'); return r.startsWith('.') ? r : `./${r}`; };
  const entry = [
    `import config from ${JSON.stringify(toImport(resolve(gamePath)))};`,
    `import { defineTcgTitle } from ${JSON.stringify(toImport(titleModule))};`,
    'export default defineTcgTitle(config);',
  ].join('\n');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir, loader: 'ts', sourcefile: `${rulesetId}.entry.ts` },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    write: false, minify: false, treeShaking: true, legalComments: 'none', logLevel: 'silent', charset: 'utf8',
  });
  return result.outputFiles[0].text.replace(/\/\/# sourceMappingURL=.*$/m, '');
}

/**
 * The checks LitNode v0.11.26 `sdk/conformance.mjs` runs before a node loads a ruleset, unsandboxed,
 * so a build stays hostable while LitNode is not installed here. Returns the failures (empty = ok).
 */
export async function compatCheck(src: string): Promise<string[]> {
  const out: string[] = [];
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  if (/^\s*import\s[\s\S]*?from\s*['"]/m.test(body) || /^\s*import\s*['"]/m.test(body)) out.push('artifact has imports');
  if (!/export\s+default\b/.test(body) && !/export\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(body)) out.push('artifact has no default export');
  const purity = [/\bMath\.random\b/, /\bnew Date\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /\bcrypto\b\s*\./, /\bfetch\s*\(/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\blocalStorage\b/, /\bprocess\.env\b/, /\brequire\s*\(/, /\bimport\s*\(/];
  for (const re of purity) if (re.test(body)) out.push(`purity: ${re.source}`);
  if (out.length) return out;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const t = mod.default;
  const m = t?.manifest;
  if (!m || m.kind !== 'replayable' || !/^[a-z0-9][a-z0-9-]*\.v\d+$/.test(m.rulesetId ?? '')) return ['manifest missing or malformed'];
  for (const fn of ['init', 'step', 'done', 'serialize', 'view', 'scores']) if (typeof t[fn] !== 'function') out.push(`contract: ${fn}() missing`);
  if (out.length) return out;
  // Conformance's smoke replay: seed 'ab'×32, 240 ticks of xorshift inputs & 0x3f, neutral stats, run twice.
  const ps = ['p0', 'p1'].map((p, i) => p.padEnd(64, `${i}`));
  const ctx = { agents: Object.fromEntries(ps.map((p) => [p, { stats: { strength: 32768, agility: 32768, resilience: 32768, intelligence: 32768 } }])) };
  const replay = (): { root: string; state: unknown } => {
    let s = 0; const seed = 'ab'.repeat(32);
    for (let i = 0; i < seed.length; i++) s = (Math.imul(s, 31) + seed.charCodeAt(i)) >>> 0;
    const next = (): number => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    let st = t.init(seed, ps, ctx);
    for (let k = 0; k < 240 && !t.done(st); k++) st = t.step(st, { [ps[0]]: next() & 0x3f, [ps[1]]: next() & 0x3f }) ?? st;
    return { root: JSON.stringify(t.serialize(st)), state: st };
  };
  const a = replay(), b = replay();
  if (a.root !== b.root) out.push('determinism: two replays differ');
  if (typeof t.done(a.state) !== 'boolean') out.push('done() must return a boolean');
  const sc = t.scores(a.state);
  if (!ps.every((p) => typeof sc?.[p] === 'number')) out.push('scores() must give a number per participant');
  if (JSON.stringify(t.view(a.state)) === a.root) out.push('view() must not equal serialize()');
  return out;
}
