// Profile the game client in headless Chrome: one cold load and N warm ones of a URL, then medians.
//
//   node scripts/profile-web.mjs <url> [--runs 5] [--gpu] [--isolate] [--detail] [--chrome <path>] [--wait 8000]
//
// Per load: time to the title screen (the client's `tessaract:title` mark), DOMContentLoaded and load, JavaScript
// bytes over the wire, main-thread long tasks after the title, which arena ran (3D or the CSS fallback, and why) and,
// if 3D, its frame stats and setup timings. By default headless Chrome renders WebGL in software (SwiftShader): a
// slow-device floor, where the client should fall back to the CSS arena. --gpu uses the real GPU.
//
// --isolate restarts Chrome for every load (same profile, so the HTTP cache stays warm): no run inherits the
// previous page's leftover GPU-process or worker work, which otherwise skews the software-rendering numbers.
// No dependencies: Node's fetch and WebSocket speak the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const url = argv.find((a) => /^https?:/.test(a)) ?? (console.error('usage: node scripts/profile-web.mjs <url> [--runs 5] [--gpu] [--isolate] [--detail]'), process.exit(1));
const runs = Number(flag('runs', 5));
const settle = Number(flag('wait', 8000));
const gpu = argv.includes('--gpu');
const isolate = argv.includes('--isolate');
const chrome = flag('chrome', process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const profile = mkdtempSync(join(tmpdir(), 'dw-profile-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start headless Chrome on the shared profile and attach to its page. */
async function launch() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', ...(gpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) { await wait(200); target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null); }
  if (!target) { proc.kill(); throw new Error('headless Chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  // Long tasks from the very first script, kept on the page for the measurement below.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true})}catch{}" });
  return { send, close: async () => { ws.close(); proc.kill(); await wait(400); } };
}

const measure = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const mark = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
  const js = performance.getEntriesByType('resource').filter((e) => /\\.js(\\?|$)/.test(e.name));
  const title = mark('tessaract:title');
  const after = (window.__lt || []).filter(([t]) => title !== null && t > title);
  const arena = document.getElementById('arena');
  return JSON.stringify({
    title, arena3d: mark('tessaract:arena3d'), dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
    jsKB: js.reduce((n, e) => n + (e.transferSize || 0), 0) / 1024, jsFiles: js.length,
    longTasksAfterTitle: after.length, lt: after.map(([t, d]) => [Math.round(t), Math.round(d)]), blockingAfterTitleMs: after.reduce((n, [, d]) => n + Math.max(0, d - 50), 0),
    arena: arena?.classList.contains('three') ? '3d' : arena?.dataset.fallback ? 'css (' + arena.dataset.fallback + ')' : 'css',
    stats: window.tessaract?.arenaStats?.() ?? null,
  });
})()`;

const results = [];
let browser = null;
try {
  for (let i = 0; i <= runs; i++) {
    if (!browser) browser = await launch();
    const sep = url.includes('?') ? '&' : '?';
    await browser.send('Page.navigate', { url: `${url}${sep}profile=${Date.now()}` });
    await wait(settle);
    const { result } = await browser.send('Runtime.evaluate', { expression: measure, returnByValue: true });
    results.push({ cold: i === 0, ...JSON.parse(result.value) });
    if (isolate) { await browser.close(); browser = null; }
  }
} finally {
  await browser?.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a lock: the temp dir is cleaned later */ }
}

const r1 = (n) => (n === null || n === undefined ? '–' : Math.round(n));
const median = (xs) => { const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const short = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
console.log(`${url}${gpu ? ' · GPU' : ' · software WebGL'}${isolate ? ' · isolated runs' : ''}\n  run    title  arena3d   dcl   load   jsKB  files  longTasks  blockMs  arena`);
for (const [i, r] of results.entries()) console.log(`  ${(r.cold ? 'cold' : `warm${i}`).padEnd(6)} ${String(r1(r.title)).padStart(5)} ${String(r1(r.arena3d)).padStart(8)} ${String(r1(r.dcl)).padStart(5)} ${String(r1(r.load)).padStart(6)} ${String(r1(r.jsKB)).padStart(6)} ${String(r.jsFiles).padStart(6)} ${String(r.longTasksAfterTitle).padStart(10)} ${String(r1(r.blockingAfterTitleMs)).padStart(8)}  ${short(r.arena)}${r.stats?.fps ? ` · ${r.stats.fps} fps, ${r.stats.frameMs} ms/frame, ${r.stats.drawCalls} draws` : ''}`);
if (argv.includes('--detail')) for (const r of results) console.log(`  long tasks after the title (start ms, duration ms): ${JSON.stringify(r.lt)}${r.stats?.setupMs ? ` · arena setup ${JSON.stringify(r.stats.setupMs)}` : ''}`);
const warm = results.filter((r) => !r.cold);
console.log(`  median (warm): title ${r1(median(warm.map((r) => r.title)))} ms · dcl ${r1(median(warm.map((r) => r.dcl)))} ms · load ${r1(median(warm.map((r) => r.load)))} ms · arena3d ${r1(median(warm.map((r) => r.arena3d)))} ms · blocking after title ${r1(median(warm.map((r) => r.blockingAfterTitleMs)))} ms · max blocking ${r1(Math.max(...warm.map((r) => r.blockingAfterTitleMs)))} ms`);
