// The built site (web/): the engine bundle and the game it ships with (the starter template; no collection).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { compileGame, createRules, greedyBot, validateGame } from "../web/engine/tessaract.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const GAME = read("../web/data/game.json");
const SNAP = read("../web/data/collection.json");
const toStats = (s) => (s ? { strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int } : {});

test("the site's game is valid and every unit maps to a collection card with local art", () => {
  assert.deepEqual(validateGame(GAME), []);
  const byToken = new Map(SNAP.cards.map((c) => [String(c.tokenId), c]));
  for (const u of GAME.cards.filter((c) => c.type === "unit" && c.token)) {
    const c = byToken.get(String(u.token.tokenId));
    assert.ok(c, `${u.id} maps to a collection card`);
    assert.ok(c.art.startsWith("./assets/art/") && existsSync(new URL(`../web/${c.art.slice(2)}`, import.meta.url)), `${u.id} art exists`);
  }
});

test("the site's engine plays the shipped game to the end", () => {
  const rules = createRules(compileGame(GAME));
  const bot = greedyBot(rules);
  const [a, b] = SNAP.cards;
  let s = rules.init("web-test", ["you", "bot"], { agents: { you: { stats: toStats(a?.stats) }, bot: { stats: toStats(b?.stats) } } });
  while (!rules.done(s)) s = rules.step(s, { you: 0, bot: 0, [s.p[s.turn].id]: bot(s) });
  assert.ok(s.winner >= 0);
});

test("index.html preloads every client module, so they load in parallel instead of one import level at a time", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const preloaded = new Set([...html.matchAll(/rel="modulepreload" href="\.\/([^"]+)"/g)].map((m) => m[1]));
  const walk = (dir) => readdirSync(new URL(`../web/${dir}/`, import.meta.url), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith(".js") ? [`${dir}/${d.name}`] : []));
  const modules = new Set(["app.js", "engine/tessaract.js", ...walk("ui"), ...walk("lib")]);
  assert.deepEqual([...preloaded].sort(), [...modules].sort());
});
