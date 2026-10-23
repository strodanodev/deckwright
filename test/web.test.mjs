// The built site (web/): the engine bundle, the game and the collection it ships with.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { compileGame, createRules, greedyBot, validateGame } from "../web/engine/deckwright.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const GAME = read("../web/data/game.json");
const SNAP = read("../web/data/collection.json");
const toStats = (s) => ({ strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int });

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
  let s = rules.init("web-test", ["you", "bot"], { agents: { you: { stats: toStats(a.stats) }, bot: { stats: toStats(b.stats) } } });
  while (!rules.done(s)) s = rules.step(s, { you: 0, bot: 0, [s.p[s.turn].id]: bot(s) });
  assert.ok(s.winner >= 0);
});
