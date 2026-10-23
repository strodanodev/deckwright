// Deckwright — the demo duel: a collection's cards as champions and units, played in the Deckwright rules
// (engine/deckwright.js, built by `pnpm web`). The rules here are the same code the match relay and the LitNode
// ruleset run, so a match replays identically everywhere. Practice is against the house bot;
// ?relay=ws://127.0.0.1:7830&name=alice joins a dev relay (`TCG_DEV=1 pnpm relay`); add &watch=1 to spectate it.
// #replay=<code> replays a shared match: the code is the whole match record, rebuilt here with the same rules.
// The meta loop (profile, Gauntlet, daily puzzle) runs in this browser; its screens are in meta.js.
// Every name on the page goes in through textContent.
import { compileGame, createRules, decode, Op, LocalBotSession, RelaySession, ReplaySession, PuzzleSession, encodeRecord, decodeRecord, REPLAY_PARAM, ENEMY_CHAMPION, enemyUnit, ownUnit, endTurn, statsFromCore, describeCard, describeEffect, KEYWORDS, createGauntlet, createPuzzles, loadProfile, saveProfile, addMatch, summarize, utcDate } from "./engine/deckwright.js";
import { createMetaScreens } from "./meta.js";
import { createWallet } from "./lib/wallet.js";
import { createHoldings } from "./lib/holdings.js";
import { shortAddress } from "./lib/util.js";

const GAME_URL = "./data/game.json";
const SNAPSHOT_URL = "./data/collection.json";
const q = new URLSearchParams(location.search);
const RELAY = q.get("relay");
const WATCH = !!RELAY && q.get("watch") === "1";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
// ERC-6699 CoreStats as the collection snapshot stores them, normalized the way LitNode hydrates them: a card
// without stats, or no champion at all, fights with every stat at 0 (the base champion).
const toStats = statsFromCore;
const elementOf = (name) => String(name ?? "neutral").toLowerCase();
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

const [game, snap] = await Promise.all([fetch(GAME_URL).then((r) => r.json()), fetch(SNAPSHOT_URL).then((r) => r.json())]);
const rules = createRules(compileGame(game));
const byToken = new Map(snap.cards.map((c) => [String(c.tokenId), c]));
// The game's unit cards carry the token they were imported from; the snapshot has that token's local painting.
document.title = `${game.title} · Deckwright`;
$("game-title").textContent = game.title;
$("collection-name").textContent = snap.collection.name;
// A card's art: its token's painting from the collection snapshot, else a local image the game names in "art"
// (the CSP serves same-origin images only, so remote and ipfs:// URLs are skipped).
// Element accents come from the game config (elements[].color), so a new theme needs no CSS edits.
const ELEMENT_COLOR = Object.fromEntries(game.elements.filter((e) => /^#[0-9a-f]{3,8}$/i.test(e.color ?? "")).map((e) => [e.id, e.color]));
const artOf = (def) => (def.token ? byToken.get(String(def.token.tokenId))?.art : null) ?? (def.art && !/^[a-z]+:/i.test(def.art) ? def.art : null);

// ------------------------------------------------------------------ wallet (optional: marks the champions you hold)
const wallet = createWallet();
// A game built without a collection has no contract to read: no wallet marking, base champions only.
const holdings = /^0x[0-9a-fA-F]{40}$/.test(snap.collection.address ?? "") ? createHoldings({ collection: { ...snap.collection, cards: snap.cards } }) : null;
if (!holdings) { $("wallet").hidden = true; document.querySelector(".pick-filter").hidden = true; }
if (!snap.cards.length) {
  $("pick-title").textContent = "Ready to duel";
  document.querySelector("#pick .lede").textContent = "This game has no NFT collection yet, so both sides fight with the base champion. Add one with `deckwright snapshot` and `deckwright import`, and each card's on-chain stats will shape its champion.";
}
let owned = new Set();
let filter = "all";

async function refreshOwned() {
  const { address } = wallet.snapshot();
  $("wallet").textContent = address ? shortAddress(address) : "Connect wallet";
  if (!address || !holdings) { owned = new Set(); renderChampions(); return; }
  try {
    const read = await holdings.read(address);
    const cards = await holdings.identify(read.tokens);
    owned = new Set([...cards.values()].filter(Boolean).map((c) => String(c.tokenId)));
  } catch (e) {
    console.warn("[duel] could not read holdings", e);
  }
  renderChampions();
  if (DECK && !$("deck").hidden) renderDeck();
}
wallet.subscribe(() => { void refreshOwned(); });
$("wallet").addEventListener("click", async () => {
  try {
    if (wallet.snapshot().address) await wallet.disconnect(); else await wallet.connect();
  } catch (e) { console.warn("[duel] wallet", e); }
  void refreshOwned();
});
wallet.restore?.().catch(() => {});

// ------------------------------------------------------------------ champion pick
function renderChampions() {
  const grid = $("champions");
  grid.replaceChildren();
  const list = snap.cards.filter((c) => filter === "all" || owned.has(String(c.tokenId)));
  if (!snap.cards.length) {
    const b = el("button", "forge", "Play with the base champion");
    b.type = "button";
    b.addEventListener("click", () => start(null));
    grid.append(b);
    return;
  }
  if (!list.length) grid.append(el("p", "lede", `No ${snap.collection.name} cards in this wallet yet. Pick any champion under All.`));
  for (const c of list) {
    const b = el("button", "champ");
    b.type = "button";
    b.dataset.el = elementOf(c.element);
    const img = el("img"); if (c.art) img.src = c.art; img.alt = ""; img.loading = "lazy";
    const meta = el("div", "meta");
    meta.append(el("div", "name", c.name), el("div", "sub", [c.kind, c.element].filter(Boolean).join(" · ")));
    const champ = rules.champion(toStats(c.stats));
    const stats = el("div", "stats");
    stats.append(el("span", null, `♥${champ.life}`), el("span", null, `✦${champ.spellPower}`), el("span", null, `⚔+${champ.unitAttack}`), el("span", null, `✋${champ.openingHand}`));
    stats.title = "life · spell power · unit attack · opening hand";
    meta.append(stats);
    const power = rules.heroPower({ tokenId: String(c.tokenId), stats: toStats(c.stats) });
    if (power) meta.append(el("div", "sub power-line", `${power.name} (${power.cost}): ${describeEffect(power.effect, nameOf)}`));
    b.append(img, meta);
    if (owned.has(String(c.tokenId))) b.append(el("span", "owned", "Held"));
    b.addEventListener("click", () => start(c));
    grid.append(b);
  }
}
for (const b of document.querySelectorAll(".pick-filter button")) {
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    for (const o of document.querySelectorAll(".pick-filter button")) o.setAttribute("aria-pressed", String(o === b));
    renderChampions();
  });
}

// ------------------------------------------------------------------ match
let session = null, mine = null, foeChamp = null, pick = null, prev = null, recent = [];   // the last few moves, newest last

// ------------------------------------------------------------------ wallet decks (deckRules.mode "declared")
// Each player declares their own deck; the declarations open the match log, so the match replays anywhere.
// Any card may be played by default (practice and casual). "Wallet deck" builds from the cards you hold. With
// &owned=1 the builder offers only held collection cards (support cards are always free). The relay enforces it
// (TCG_OWNED=1, the default for ranked): it reads the wallet's holdings on chain and rejects anything else.
const DECK = game.deckRules?.mode === "declared" ? game.deckRules : null;
const tokenOf = (def) => (def.token ? String(def.token.tokenId) : null);
const deckKey = `deckwright.deck.${game.litnode.rulesetId}`;
let deck = [], lastDeck = null;
const requireOwned = () => !!RELAY && q.get("owned") === "1";
const allowed = (def) => !requireOwned() || !tokenOf(def) || owned.has(tokenOf(def));
const copies = (i) => deck.filter((d) => d === i).length;

function openDeckBuilder(champion) {
  mine = champion;
  try { deck = JSON.parse(localStorage.getItem(deckKey) ?? "[]").filter((i) => Number.isInteger(i) && game.cards[i]); } catch { deck = []; }
  deck = deck.filter((i) => allowed(game.cards[i])).slice(0, DECK.size);
  $("deck-rule").textContent = `Pick ${DECK.size} cards, up to ${DECK.maxCopies} of each. ${requireOwned() ? "Owned-only match: collection cards must be in your wallet; support cards are always available." : "Any card is allowed in practice and casual matches; cards your wallet holds are marked, and Wallet deck builds from them."}`;
  $("pick").hidden = true; if ($("build")) $("build").hidden = true; $("deck").hidden = false;
  renderDeck();
}

function renderDeck() {
  $("deck-count").textContent = `${deck.length} / ${DECK.size}`;
  $("deck-start").disabled = deck.length !== DECK.size;
  $("deck-wallet").hidden = owned.size === 0;
  const grid = $("deck-cards");
  grid.replaceChildren();
  game.cards.forEach((def, i) => {
    const ok = allowed(def), n = copies(i);
    const tile = el("div", `deck-tile${ok ? "" : " locked"}${n ? " in" : ""}`);
    const minus = el("button", null, "\u2212"), plus = el("button", null, "+");
    minus.type = plus.type = "button";
    minus.setAttribute("aria-label", `Remove ${def.name}`); plus.setAttribute("aria-label", `Add ${def.name}`);
    minus.disabled = !n;
    plus.disabled = !ok || n >= DECK.maxCopies || deck.length >= DECK.size;
    minus.addEventListener("click", () => { deck.splice(deck.lastIndexOf(i), 1); renderDeck(); });
    plus.addEventListener("click", () => { deck.push(i); renderDeck(); });
    const qty = el("div", "qty");
    qty.append(minus, el("span", null, `${n}`), plus);
    const held = tokenOf(def) && owned.has(tokenOf(def));
    tile.append(cardEl(def), qty, el("span", "note", !ok ? "Not in wallet" : held ? "Held" : tokenOf(def) ? "" : "Support"));
    grid.append(tile);
  });
}

$("deck-suggest").addEventListener("click", () => {
  deck = [];
  const room = (i) => allowed(game.cards[i]) && copies(i) < DECK.maxCopies && deck.length < DECK.size;
  for (const i of rules.game.suggestedDeck) if (room(i)) deck.push(i);
  for (const i of rules.game.deckList) if (room(i)) deck.push(i);   // fill what the wallet could not
  for (let i = 0; i < game.cards.length && deck.length < DECK.size; i++) while (room(i)) deck.push(i);
  renderDeck();
});
$("deck-wallet").addEventListener("click", () => {
  // Held collection cards first (as many copies as the rules allow), then support cards, then the suggestion.
  deck = [];
  const room = (i) => allowed(game.cards[i]) && copies(i) < DECK.maxCopies && deck.length < DECK.size;
  game.cards.forEach((def, i) => { if (tokenOf(def) && owned.has(tokenOf(def))) while (room(i)) deck.push(i); });
  game.cards.forEach((def, i) => { if (!tokenOf(def)) while (room(i)) deck.push(i); });
  for (const i of rules.game.suggestedDeck) if (room(i)) deck.push(i);
  renderDeck();
});
$("deck-clear").addEventListener("click", () => { deck = []; renderDeck(); });
$("deck-back").addEventListener("click", () => { $("deck").hidden = true; $("pick").hidden = false; if ($("build")) $("build").hidden = false; });
$("deck-start").addEventListener("click", () => {
  try { localStorage.setItem(deckKey, JSON.stringify(deck)); } catch { /* private mode: the deck just isn't remembered */ }
  lastDeck = deck.slice();
  $("deck").hidden = true;
  beginMatch(mine, lastDeck);
});

function start(champion) {
  if (mode === "gauntlet") { startRun(champion); return; }
  if (DECK) openDeckBuilder(champion); else beginMatch(champion, null);
}

function beginMatch(champion, declaredDeck) {
  session?.close();
  mine = champion;
  const others = snap.cards.filter((c) => c !== champion);
  foeChamp = RELAY || !others.length ? null : others[Math.floor(Math.random() * others.length)];
  const claim = champion ? { tokenId: String(champion.tokenId), stats: toStats(champion.stats) } : undefined;
  session = RELAY
    ? RelaySession.dev(rules, RELAY, q.get("name") ?? `player-${randomSeed().slice(0, 6)}`, claim, wallet.snapshot().address ?? undefined)
    : new LocalBotSession(rules, randomSeed(), claim, foeChamp ? { tokenId: String(foeChamp.tokenId), stats: toStats(foeChamp.stats) } : undefined);
  openSession(RELAY ? "Dev relay" : "Practice vs bot", { kind: RELAY ? "relay" : "practice", opponent: RELAY ? "Opponent" : foeChamp?.name ?? "House bot" });
  if (declaredDeck) session.declareDeck(declaredDeck);
  render();
}

/** Show the board for a new match; `ctx` says what it is, for the profile and the result card. */
function openSession(label, ctx) {
  context = ctx; recorded = false;
  $("mode").textContent = label;
  pick = null; prev = null; recent = [];
  session.onChange(render);
  showBoard(); setViewMode(null);
  $("watch-link").hidden = ctx.kind !== "relay";
  $("concede").hidden = ctx.kind === "puzzle";
}

// ------------------------------------------------------------------ meta loop: profile, Gauntlet, daily puzzle
// The profile lives in this browser (localStorage). The Gauntlet and the daily puzzle are seeded from a run seed and
// the date, so they need no server, and every match in them is an ordinary replayable record.
const store = (() => { try { return window.localStorage; } catch { return null; } })();
let profile = loadProfile(store, game.litnode.rulesetId);
const gauntlet = createGauntlet(rules);
const puzzles = createPuzzles(rules);
let todaysPuzzle;   // undefined until generated; null when the day has none
let mode = "practice";
let context = { kind: "practice" };
let recorded = false;
const saveProf = () => saveProfile(store, profile);
const activeRun = () => profile.gauntlet.current;
const champName = (tokenId) => (tokenId ? byToken.get(String(tokenId))?.name ?? `#${tokenId}` : "Base champion");
const screens = createMetaScreens({ el, cardEl: (def) => cardEl(def), champName, game, rules });

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll("#modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  $("pick-champs").hidden = !(m === "practice" || (m === "gauntlet" && !activeRun()));
  $("pick-title").textContent = m === "gauntlet" ? "Choose a champion for your run" : "Choose your champion";
  for (const id of ["gauntlet", "puzzle", "profile"]) $(`${id}-panel`).hidden = m !== id;
  renderMeta();
}
for (const b of document.querySelectorAll("#modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
if (RELAY) $("modes").hidden = true;   // a two-player link is about that match only

/** End the current run in the profile's totals (a finished run is counted once). */
function closeRun() {
  const run = activeRun();
  if (run && !run.counted) {
    profile.gauntlet.runs++;
    profile.gauntlet.bestStage = Math.max(profile.gauntlet.bestStage, run.wins);
    if (run.cleared) profile.gauntlet.cleared++;
  }
  profile.gauntlet.current = null;
  saveProf();
}

function renderMeta() {
  if (mode === "profile") screens.profile($("profile-panel"), profile, summarize(profile), { onWatch: watchCode, puzzleToday: !!profile.puzzles[utcDate(Date.now())] });
  if (mode === "gauntlet") {
    screens.gauntlet($("gauntlet-panel"), activeRun(), gauntlet, {
      onFight: startGauntletMatch,
      onChoose: (i) => { profile.gauntlet.current = gauntlet.choose(activeRun(), i); saveProf(); renderMeta(); },
      onNewRun: () => { closeRun(); setMode("gauntlet"); },
      hasCollection: snap.cards.length > 0,
      onStartBase: () => startRun(null),
    });
  }
  if (mode === "puzzle") {
    if (todaysPuzzle === undefined) {
      // Generating takes a moment (a seeded bot match plus difficulty playouts): draw the panel first.
      screens.puzzle($("puzzle-panel"), null, null, { generating: true });
      setTimeout(() => { todaysPuzzle = puzzles.daily(utcDate(Date.now())); renderMeta(); }, 30);
      return;
    }
    screens.puzzle($("puzzle-panel"), todaysPuzzle, todaysPuzzle ? profile.puzzles[todaysPuzzle.date] ?? null : null, { onPlay: startPuzzle });
  }
}

async function watchCode(code) {
  try { startReplay(await decodeRecord(code), code); }
  catch (e) { showNotice(`Couldn't open that replay: ${e.message}.`); }
}

function startRun(champion) {
  profile.gauntlet.current = gauntlet.start(randomSeed(), champion ? { tokenId: String(champion.tokenId), stats: toStats(champion.stats) } : undefined);
  saveProf();
  setMode("gauntlet");
}

function startGauntletMatch() {
  const run = activeRun();
  if (!run || run.over || run.offers.length) return;
  const opp = gauntlet.opponent(run), me = gauntlet.player(run);
  session?.close();
  mine = me.tokenId ? byToken.get(me.tokenId) ?? null : null;
  foeChamp = opp.tokenId ? byToken.get(opp.tokenId) ?? null : null;
  session = new LocalBotSession(rules, `${run.seed}-stage-${opp.stage}`, { tokenId: me.tokenId, stats: me.stats }, { tokenId: opp.tokenId, stats: opp.stats }, { level: opp.level, foeDeck: opp.deck });
  openSession(`Gauntlet · stage ${opp.stage}`, { kind: "gauntlet", opponent: opp.name, detail: `stage ${opp.stage}` });
  if (DECK) session.declareDeck(me.deck);
  render();
}

function startPuzzle() {
  const p = todaysPuzzle;
  if (!p) return;
  session?.close();
  session = new PuzzleSession(rules, p);
  mine = byToken.get(String(p.agents[p.participants[p.side]].tokenId)) ?? null;
  foeChamp = byToken.get(String(p.agents[p.participants[1 - p.side]].tokenId)) ?? null;
  openSession("Daily puzzle", { kind: "puzzle", opponent: "Rival", detail: p.date });
  render();
}

/** Once per match: into the profile (with its replay), and into the Gauntlet run or the puzzle streak. */
async function onFinished(s, meIdx, puzzleState) {
  if (recorded || viewing()) return;
  recorded = true;
  if (context.kind === "puzzle") {
    // Attempts aren't matches: a solve counts once per day, toward the puzzle streak.
    if (puzzleState === "solved" && !profile.puzzles[session.puzzle.date]) { profile.puzzles[session.puzzle.date] = { at: Date.now(), actions: session.actions }; saveProf(); }
    return;
  }
  const won = s.winner === meIdx;
  const result = s.winner === 2 ? "draw" : won ? "win" : "loss";
  if (context.kind === "gauntlet" && activeRun()) {
    const run = gauntlet.result(activeRun(), won);
    profile.gauntlet.current = run;
    if (run.over) { closeRun(); profile.gauntlet.current = { ...run, counted: true }; }
  }
  let replay;
  try { replay = await encodeRecord(session.record()); } catch { /* the result still counts without a replay */ }
  profile = addMatch(profile, { at: Date.now(), mode: context.kind, result, turns: s.turnNo, ruleset: game.litnode.rulesetId, ...(mine ? { champion: String(mine.tokenId) } : {}), opponent: context.opponent, ...(replay ? { replay } : {}), ...(context.detail ? { detail: context.detail } : {}) });
  saveProf();
}

const act = (x) => { pick = null; session.act(x); };

// ------------------------------------------------------------------ replays and spectators
// A replay link carries the whole match record in its #fragment, which the browser never sends to a server, and
// this page rebuilds every state from it with the same rules. ?relay=…&watch=1 watches a live match without a seat.
const viewing = () => !!session && session.role !== "player";
const replaying = () => session?.role === "replay";
const shortId = (id) => (/^[0-9a-f]{64}$/i.test(id) ? `${id.slice(0, 6)}\u2026${id.slice(-4)}` : id);
const playerName = (id) => (id === "you" ? "Player" : id === "bot" ? "House bot" : shortId(String(id)));
const champOf = (id) => byToken.get(String(session?.champions?.[id]?.tokenId)) ?? null;
const replayUrl = (code) => `${location.origin}${location.pathname}#${REPLAY_PARAM}=${code}`;
const watchUrl = () => `${location.origin}${location.pathname}?relay=${encodeURIComponent(RELAY)}&watch=1`;
let shareCode = null;   // the code of the replay on screen

function showBoard() {
  for (const id of ["pick", "deck", "result", "share"]) $(id).hidden = true;
  if ($("build")) $("build").hidden = true;
  $("notice").hidden = true;
  $("board").hidden = false;
}
/** null while playing; "replay" or "live" while watching (replaces End turn / Concede with the view bar). */
function setViewMode(kind) {
  $("viewbar").hidden = !kind;
  $("viewbar").classList.toggle("live", kind === "live");
  $("play-controls").hidden = !!kind;
  $("vb-share").textContent = kind === "live" ? "Copy watch link" : "Copy link";
}
function exitView() {
  session?.close(); session = null;
  // A spectator URL would rejoin the relay on reload: leave it for the plain page.
  if (WATCH) { location.assign(location.pathname); return; }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  setViewMode(null);
  $("result").hidden = true; $("board").hidden = true; $("pick").hidden = false;
  if ($("build")) $("build").hidden = false;
}
function showNotice(text) {
  exitView();
  $("notice").textContent = text;
  $("notice").hidden = false;
}
async function copyText(text, button, label) {
  try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
  catch { button.textContent = "Select it"; }
  setTimeout(() => { button.textContent = label; }, 1600);
}

function startReplay(record, code) {
  let next;
  try { next = new ReplaySession(rules, record); }
  catch (e) { showNotice(`Can't play this replay: ${e.message}.`); return; }
  session?.close();
  session = next; shareCode = code;
  mine = null; foeChamp = null; pick = null; prev = null; recent = [];
  $("mode").textContent = "Replay";
  session.onChange(render);
  showBoard(); setViewMode("replay");
  render();
}
async function loadReplayFromHash() {
  const m = new RegExp(`^#${REPLAY_PARAM}=([A-Za-z0-9_-]+)$`).exec(location.hash);
  if (!m) return;
  try { startReplay(await decodeRecord(m[1]), m[1]); }
  catch (e) { showNotice(`Couldn't open that replay link: ${e.message}.`); }
}
function startWatching() {
  session = RelaySession.watch(rules, RELAY);
  mine = null; foeChamp = null; pick = null; prev = null; recent = [];
  $("mode").textContent = "Spectating";
  session.onChange(render);
  showBoard(); setViewMode("live");
  render();
}

function renderViewbar(s) {
  if (!replaying()) { $("vb-pos").textContent = session?.status ?? ""; return; }
  const r = session;
  $("vb-scrub").max = String(r.length);
  $("vb-scrub").value = String(r.cursor);
  $("vb-pos").textContent = s.phase === "decks" ? `deck building \u00b7 move ${r.cursor}/${r.length}` : `turn ${s.turnNo} \u00b7 move ${r.cursor}/${r.length}`;
  $("vb-play").textContent = r.playing ? "Pause" : r.cursor >= r.length ? "Replay" : "Play";
  $("vb-play").setAttribute("aria-label", r.playing ? "Pause" : "Play");
  $("vb-start").disabled = $("vb-prev").disabled = $("vb-prev-turn").disabled = r.cursor <= 0;
  $("vb-end").disabled = $("vb-next").disabled = $("vb-next-turn").disabled = r.cursor >= r.length;
}

const stepTo = (k) => { if (!replaying()) return; session.pause(); session.seek(k); };
$("vb-start").addEventListener("click", () => stepTo(session.cursor > session.playStart ? session.playStart : 0));
$("vb-prev").addEventListener("click", () => stepTo(session.cursor - 1));
$("vb-next").addEventListener("click", () => stepTo(session.cursor + 1));
$("vb-prev-turn").addEventListener("click", () => stepTo(session.turnStart(session.cursor, -1)));
$("vb-next-turn").addEventListener("click", () => stepTo(session.turnStart(session.cursor, 1)));
$("vb-end").addEventListener("click", () => stepTo(session.length));
$("vb-play").addEventListener("click", () => { if (replaying()) { if (session.playing) session.pause(); else session.play(); } });
$("vb-scrub").addEventListener("input", (e) => stepTo(Number(e.target.value)));
$("vb-flip").addEventListener("click", () => {
  if (replaying()) { session.flip(); return; }
  const ids = session?.state?.p.map((p) => p.id);
  if (ids) { session.you = ids.find((id) => id !== session.you); prev = null; render(); }
});
$("vb-share").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!replaying()) { await copyText(watchUrl(), b, "Copy watch link"); return; }
  await copyText(replayUrl(shareCode ?? await encodeRecord(session.record())), b, "Copy link");
});
$("vb-exit").addEventListener("click", exitView);
$("watch-link").addEventListener("click", (e) => copyText(watchUrl(), e.currentTarget, "Copy watch link"));
document.addEventListener("keydown", (e) => {
  if (!replaying() || e.target instanceof HTMLInputElement) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(session.cursor - 1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepTo(session.cursor + 1); }
  else if (e.key === " ") { e.preventDefault(); $("vb-play").click(); }
});

$("watch-replay").addEventListener("click", async () => {
  const rec = session?.record();
  if (!rec) return;
  const code = await encodeRecord(rec);
  history.replaceState(null, "", `${location.pathname}${location.search}#${REPLAY_PARAM}=${code}`);
  startReplay(rec, code);
});
$("share-replay").addEventListener("click", async () => {
  const rec = session?.record();
  if (!rec) return;
  $("share-url").value = replayUrl(await encodeRecord(rec));
  $("share").hidden = false;
  $("share-url").select();
});
$("share-copy").addEventListener("click", (e) => copyText($("share-url").value, e.currentTarget, "Copy"));

// Card text comes from the rules library (core/effects.ts), so a new effect or keyword needs no client change.
const nameOf = (id) => game.cards.find((c) => c.id === id)?.name ?? id;
const describe = (def) => describeCard(def, nameOf).join(" · ");
const keywordHelp = (def) => (def.keywords ?? []).map((k) => `${k}: ${KEYWORDS[k] ?? ""}`).join("\n");

function cardEl(def, { unit = null, small = false } = {}) {
  const b = el("button", `card ${def.type}${small ? " small" : ""}`);
  b.type = "button";
  b.dataset.el = def.element;
  if (ELEMENT_COLOR[def.element]) b.style.setProperty("--el", ELEMENT_COLOR[def.element]);
  const art = artOf(def);
  if (art) { const img = el("img"); img.src = art; img.alt = ""; b.append(img); }
  else b.append(el("div", "glyph", def.type === "spell" ? "✦" : def.type === "relic" ? "◆" : "⚔"));
  const foot = el("div", "foot");
  foot.append(el("div", "name", def.name));
  const text = describe(def);
  if (text) foot.append(el("div", "text", text));
  b.append(foot);
  if (!unit) b.append(el("div", "cost", def.cost));
  if (def.type === "unit") {
    b.append(el("div", "atk", unit ? unit.atk : def.attack), el("div", "hp", unit ? unit.hp : def.health));
  }
  if (unit?.guard) { b.classList.add("guard"); b.append(el("div", "tag", "guard")); }
  if (unit?.shield) b.classList.add("shielded");
  if (unit && !unit.ready) b.classList.add("tired");
  const help = keywordHelp(def);
  if (help) b.title = help;
  b.setAttribute("aria-label", `${def.name}${def.type === "unit" ? `, ${unit ? unit.atk : def.attack} attack, ${unit ? unit.hp : def.health} health` : ""}${text ? `, ${text}` : ""}`);
  return b;
}

function heroEl(p, champ, label, hurt, onClick, powerBtn = null) {
  const wrap = el("div", "hero");
  wrap.dataset.el = champ ? elementOf(champ.element) : "neutral";
  const face = el("button", "hero-face");
  face.type = "button";
  if (champ?.art) { const img = el("img"); img.src = champ.art; img.alt = ""; face.append(img); }
  face.setAttribute("aria-label", `${label}: ${p.life} life`);
  if (onClick) { face.classList.add("target"); face.addEventListener("click", onClick); }
  const life = el("div", `life${hurt ? " hit" : ""}`, p.life);
  life.append(el("small", null, "LIFE"));
  const info = el("div", "hero-info");
  info.append(el("span", "who", champ ? `${label} · ${champ.name}` : label));
  const energy = el("span", "energy");
  energy.title = `energy ${p.energy}/${p.energyCap}`;
  for (let i = 0; i < Math.max(p.energyCap, p.energy); i++) energy.append(el("i", i < p.energy ? "full" : ""));
  info.append(energy, el("span", null, `deck ${p.deck.length} · hand ${p.hand.length}${p.spellPower ? ` · spell +${p.spellPower}` : ""}${p.unitAttack ? ` · units +${p.unitAttack}` : ""}`));
  if (powerBtn) info.append(powerBtn);
  wrap.append(face, life, info);
  return wrap;
}

/** The hero power button: usable when the rules list a Power action; aimed powers ask for a target first. */
function powerEl(p, moves, mine) {
  const pw = p.power >= 0 ? game.champion.powers?.[p.power] : null;
  if (!pw) return null;
  const b = el("button", "power", `${pw.name} · ${pw.cost}`);
  b.type = "button";
  b.title = describeEffect(pw.effect, nameOf);
  const uses = mine ? moves.filter((m) => m.op === Op.Power) : [];
  b.disabled = !uses.length;
  if (p.powerUsed) b.classList.add("used");
  if (pick?.kind === "power") b.classList.add("picked");
  b.addEventListener("click", () => {
    if (uses.length === 1 && uses[0].target === 0) { act(uses[0].x); return; }
    pick = pick?.kind === "power" ? null : { kind: "power", index: 0 };
    render();
  });
  return b;
}

/** One line about what just happened, read from the action against the state before it. */
function narrate(before, s, meIdx) {
  const x = s.last;
  if (!before || !x) return;
  const { op, a, target } = decode(x);
  const actor = before.turn, P = before.p[actor], E = before.p[actor === 0 ? 1 : 0];
  const watching = viewing();
  const who = watching ? playerName(P.id) : actor === meIdx ? "You" : "Opponent";
  const card = (c) => game.cards[c]?.name ?? "a card";
  const enemyChampion = watching ? `${playerName(E.id)}'s champion` : actor === meIdx ? "the enemy champion" : "your champion";
  const tgt = () => (target === ENEMY_CHAMPION ? enemyChampion : target < 10 ? card(E.board[target - 1]?.c) : target === 10 ? "" : card(P.board[target - 11]?.c));
  let line = "";
  if (op === Op.Play) line = `${who} played ${card(P.hand[a])}${target ? ` → ${tgt()}` : ""}`;
  else if (op === Op.Power) line = `${who} used ${game.champion.powers?.[P.power]?.name ?? "a power"}${target ? ` → ${tgt()}` : ""}`;
  else if (op === Op.Attack) line = `${who}: ${card(P.board[a]?.c)} attacked ${tgt()}`;
  else if (op === Op.End) line = `${who} ended the turn`;
  else if (op === Op.Concede) line = watching ? `${playerName(s.p[s.winner === 0 ? 1 : 0].id)} conceded` : `${s.winner === meIdx ? "Opponent" : "You"} conceded`;
  if (line) recent = [...recent, line].slice(-3);
}

function render() {
  const s = session?.state;
  if (!s) { $("status").textContent = session?.status ?? ""; renderViewbar(null); return; }
  const watching = viewing();
  if (s.phase === "decks") {
    // Two-player: waiting for both declarations (the relay fills a missing deck with the suggested one at its deadline).
    for (const id of ["foe-hero", "my-hero", "foe-relics", "my-relics", "foe-lane", "my-lane", "hand"]) $(id).replaceChildren();
    const meIdx = s.p[0].id === session.you ? 0 : 1;
    const [a, b] = watching ? [playerName(s.p[meIdx].id), playerName(s.p[1 - meIdx].id)] : ["you", "opponent"];
    $("status").textContent = `Declaring decks \u00b7 ${a} ${s.decl[meIdx].length}/${DECK.size} \u00b7 ${b} ${s.decl[1 - meIdx].length}/${DECK.size}`;
    $("end").disabled = true;
    renderViewbar(s);
    return;
  }
  const meIdx = s.p[0].id === session.you ? 0 : 1;
  const me = s.p[meIdx], foe = s.p[meIdx === 0 ? 1 : 0];
  // A replay can jump anywhere: compare with the state just before the cursor, and narrate the last few moves.
  const before = replaying() ? session.states[session.cursor - 1] ?? null : prev;
  if (replaying()) {
    recent = [];
    for (let k = Math.max(session.playStart + 1, session.cursor - 2); k <= session.cursor; k++) narrate(session.states[k - 1], session.states[k], meIdx);
  } else if (s !== prev) narrate(prev, s, meIdx);   // a re-render for a pick is not a new action
  const sameView = before && before.p[meIdx].id === me.id;
  const hurtMe = sameView && before.p[meIdx].life > me.life, hurtFoe = sameView && before.p[meIdx === 0 ? 1 : 0].life > foe.life;
  prev = s;
  const myTurn = !watching && !s.over && s.turn === meIdx;
  const legal = myTurn ? rules.legalActions(s) : [];
  const moves = legal.map((x) => ({ x, ...decode(x) }));
  const targets = new Map();   // target code -> action, for the current pick
  const pickOp = { hand: Op.Play, unit: Op.Attack, power: Op.Power };
  if (pick) for (const m of moves) if (m.op === pickOp[pick.kind] && m.a === pick.index) targets.set(m.target, m.x);

  if (RELAY && !watching && !foeChamp) foeChamp = byToken.get(String(session.champions?.[foe.id]?.tokenId)) ?? null;
  const foeHero = heroEl(foe, watching ? champOf(foe.id) : foeChamp, watching ? playerName(foe.id) : RELAY ? "Opponent" : context.opponent ?? "House bot", hurtFoe, targets.has(ENEMY_CHAMPION) ? () => act(targets.get(ENEMY_CHAMPION)) : null, powerEl(foe, moves, false));
  $("foe-hero").replaceChildren(...foeHero.childNodes);
  $("foe-hero").dataset.el = foeHero.dataset.el;
  const myHero = heroEl(me, watching ? champOf(me.id) : mine, watching ? playerName(me.id) : "You", hurtMe, null, powerEl(me, moves, true));
  $("my-hero").replaceChildren(...myHero.childNodes);
  $("my-hero").dataset.el = myHero.dataset.el;

  $("foe-relics").replaceChildren(...foe.relics.map((c) => cardEl(game.cards[c], { small: true })));
  $("my-relics").replaceChildren(...me.relics.map((c) => cardEl(game.cards[c], { small: true })));

  $("foe-lane").replaceChildren(...foe.board.map((u, slot) => {
    const b = cardEl(game.cards[u.c], { unit: u });
    const x = targets.get(enemyUnit(slot));
    if (x !== undefined) { b.classList.add("target"); b.addEventListener("click", () => act(x)); }
    return b;
  }));
  $("my-lane").replaceChildren(...me.board.map((u, slot) => {
    const b = cardEl(game.cards[u.c], { unit: u });
    const buff = targets.get(ownUnit(slot));
    const canAttack = moves.some((m) => m.op === Op.Attack && m.a === slot);
    if (buff !== undefined) { b.classList.add("target"); b.addEventListener("click", () => act(buff)); }
    else if (canAttack) {
      b.classList.add("can");
      if (pick?.kind === "unit" && pick.index === slot) b.classList.add("picked");
      b.addEventListener("click", () => { pick = pick?.kind === "unit" && pick.index === slot ? null : { kind: "unit", index: slot }; render(); });
    }
    return b;
  }));
  $("hand").replaceChildren(...me.hand.map((c, index) => {
    const def = game.cards[c];
    const b = cardEl(def);
    const plays = moves.filter((m) => m.op === Op.Play && m.a === index);
    if (watching) return b;   // spectators and replays see the hand (open information) but don't play it
    if (!plays.length) { b.classList.add("dead"); return b; }
    b.classList.add("can");
    if (pick?.kind === "hand" && pick.index === index) b.classList.add("picked");
    // A card needs a target pick when the rules offer more than one, or one that isn't the default (0).
    const aimed = plays.length > 1 || plays[0].target !== 0;
    b.addEventListener("click", () => {
      if (!aimed) { act(plays[0].x); return; }
      pick = pick?.kind === "hand" && pick.index === index ? null : { kind: "hand", index };
      render();
    });
    return b;
  }));

  $("end").disabled = !myTurn;
  $("concede").disabled = s.over;
  const hint = !myTurn ? "" : pick?.kind === "hand" ? `choose a target for ${game.cards[me.hand[pick.index]]?.name}` : pick?.kind === "power" ? "choose a target for your hero power" : pick?.kind === "unit" ? "choose what to attack" : "play cards, attack, use your hero power, or end the turn";
  const status = $("status");
  status.replaceChildren();
  const outcome = s.winner === 2 ? "a draw" : s.winner >= 0 ? `${playerName(s.p[s.winner].id)} won` : "";
  const headline = watching
    ? (s.over ? `Match over \u00b7 ${outcome}` : `${playerName(s.p[s.turn].id)}'s turn`)
    : (s.over ? "Match over" : myTurn ? "Your turn" : "Opponent's turn");
  status.append(el("b", null, headline), ` · turn ${s.turnNo}${hint ? ` · ${hint}` : ""}`);
  if (recent.length) status.append(el("br"), recent.join(" · "));
  if (!replaying() && session.status && !/^practice|^live$|^watching|^puzzle$/.test(session.status)) status.append(el("br"), session.status);
  renderViewbar(s);

  // Players and spectators get the result card; a replay just stops on its last move. A puzzle ends when its turn does.
  const puzzleState = session instanceof PuzzleSession ? puzzles.status(session.puzzle, s) : null;
  const finished = puzzleState ? puzzleState !== "playing" : s.over;
  if (finished && !replaying() && $("result").hidden) {
    const kind = context.kind;
    if (puzzleState) {
      $("result-title").textContent = puzzleState === "solved" ? "Solved!" : "Not this time";
      $("result-sub").textContent = puzzleState === "solved" ? `${session.actions} actions (the bot needed ${session.puzzle.par})` : "Your turn ended without a win. Try another line.";
    } else {
      $("result-title").textContent = watching ? (s.winner === 2 ? "Draw" : `${playerName(s.p[s.winner].id)} wins`) : s.winner === 2 ? "Draw" : s.winner === meIdx ? "Victory" : "Defeat";
      $("result-sub").textContent = `${s.turnNo} turns · ${watching ? `${playerName(me.id)} ${me.life} life · ${playerName(foe.id)} ${foe.life} life` : `${me.life} life left`}${RELAY && !watching ? ` · ${session.status}` : ""}${kind === "gauntlet" ? ` · ${context.detail}` : ""}`;
    }
    $("again").hidden = watching;
    $("again").textContent = kind === "gauntlet" ? "Back to the Gauntlet" : kind === "puzzle" ? (puzzleState === "solved" ? "Back to the puzzle" : "Retry") : "Rematch";
    $("change").textContent = watching ? "Exit" : kind === "practice" || kind === "relay" ? "New champion" : "Menu";
    $("share").hidden = true;
    $("result").hidden = false;
    void onFinished(s, meIdx, puzzleState);
  } else if (s.over && !replaying() && RELAY && !watching) {
    $("result-sub").textContent = `${s.turnNo} turns · ${me.life} life left · ${session.status}`;   // settlement status updates
  }
}

$("end").addEventListener("click", () => act(endTurn()));
// Two clicks to concede: the first arms the button for a few seconds.
let concedeArmed = null;
$("concede").addEventListener("click", () => {
  const b = $("concede");
  if (concedeArmed) { clearTimeout(concedeArmed); concedeArmed = null; b.textContent = "Concede"; session?.concede(); return; }
  b.textContent = "Really concede?";
  concedeArmed = setTimeout(() => { concedeArmed = null; b.textContent = "Concede"; }, 3000);
});
$("again").addEventListener("click", () => {
  if (context.kind === "gauntlet") { exitView(); setMode("gauntlet"); return; }
  if (context.kind === "puzzle") {
    if (puzzles.status(session.puzzle, session.state) === "solved") { exitView(); setMode("puzzle"); return; }
    $("result").hidden = true; recorded = false; prev = null; recent = []; session.retry(); return;
  }
  if (lastDeck) beginMatch(mine, lastDeck); else start(mine);
});
$("change").addEventListener("click", () => { lastDeck = null; exitView(); setMode(context.kind === "gauntlet" || context.kind === "puzzle" ? context.kind : "practice"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pick) { pick = null; render(); } });

// "Build your own" copy buttons (demo site only; the section is not in scaffolded games).
for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = "Copied"; }
    catch { b.textContent = "Select it"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1600);
  });
}

renderChampions();
void refreshOwned();
// A replay fragment wins over ?watch=1: "Watch replay" from the spectator view keeps the relay query in the URL.
if (location.hash.startsWith(`#${REPLAY_PARAM}=`)) void loadReplayFromHash();
else if (WATCH) startWatching();
window.addEventListener("hashchange", () => { void loadReplayFromHash(); });
