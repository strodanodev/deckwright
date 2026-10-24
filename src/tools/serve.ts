/**
 * Serve the game site (./web) locally with the same response headers production sends (./vercel.json),
 * so a CSP violation shows up on localhost, not after a deploy. One local-only addition: the dev relay
 * (`TCG_DEV=1 tessaract relay`, ws://127.0.0.1:7830) joins connect-src here and nowhere else.
 *
 *   tessaract dev [--port 4173] [--dir web]
 *
 * Binds to 127.0.0.1 only: open http://127.0.0.1:<port>, not localhost (which may resolve to IPv6).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { die, flag, parseArgs } from './common';
import { pkgPath } from './paths';

const args = parseArgs();
const WEB = resolve(flag(args, 'dir') ?? 'web');
if (!existsSync(join(WEB, 'index.html'))) die(`no site at ${WEB} (run \`tessaract web <game.json>\` first, or pass --dir)`);
const vercelJson = existsSync('vercel.json') ? resolve('vercel.json') : pkgPath('vercel.json');
const LOCAL_RELAY = 'ws://127.0.0.1:7830 ws://localhost:7830';
type Rule = { source: string; headers: Array<{ key: string; value: string }> };
const rules = ((JSON.parse(readFileSync(vercelJson, 'utf8')) as { headers?: Rule[] }).headers ?? []).map((r) => ({
  re: new RegExp(`^${r.source}$`),
  headers: r.headers.map(({ key, value }) => ({ key, value: key.toLowerCase() === 'content-security-policy' ? value.replace(/connect-src ([^;]*)/, `connect-src $1 ${LOCAL_RELAY}`) : value })),
}));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(WEB, decodeURIComponent(url.pathname)));
  if (file !== WEB && !file.startsWith(WEB + sep)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
  for (const r of rules) if (r.re.test(url.pathname)) for (const { key, value } of r.headers) res.setHeader(key, value);
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
const port = Number(flag(args, 'port') ?? process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`Tessaract dev server on http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port} (serving ${WEB})`);
});
