// Deckwright — the demo duel: a collection's cards as champions and units, played in the Deckwright rules
// (engine/deckwright.js, built by `pnpm web`). The rules here are the same code the match relay and the LitNode
// ruleset run, so a match replays identically everywhere. Practice is against the house bot;
// ?relay=ws://127.0.0.1:7830&name=alice joins a dev relay (`TCG_DEV=1 pnpm relay`).
// Every name on the page goes in through textContent.
import { compileGame, createRules, decode, Op, LocalBotSession, RelaySession, ENEMY_CHAMPION, enemyUnit, ownUnit, endTurn } from "./engine/deckwright.js";
import { createWallet } from "./lib/wallet.js";
import { createHoldings } from "./lib/holdings.js";
import { shortAddress } from "./lib/util.js";

const GAME_URL = "./data/game.json";
const SNAPSHOT_URL = "./data/collection.json";
const q = new URLSearchParams(location.search);
const RELAY = q.get("relay");

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
// ERC-6699 CoreStats as the collection snapshot stores them; a card without stats fights with neutral ones.
const toStats = (s) => (s ? { strength: s.str, agility: s.agi, resilience: s.res, intelligence: s.int } : {});
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
// A game built without a collection has no contract to read: no wallet marking, neutral champions only.
const holdings = /^0x[0-9a-fA-F]{40}$/.test(snap.collection.address ?? "") ? createHoldings({ collection: { ...snap.collection, cards: snap.cards } }) : null;
if (!holdings) { $("wallet").hidden = true; document.querySelector(".pick-filter").hidden = true; }
if (!snap.cards.length) {
  $("pick-title").textContent = "Ready to duel";
  document.querySelector("#pick .lede").textContent = "This game has no NFT collection yet, so both sides fight with neutral champions. Add one with `deckwright snapshot` and `deckwright import`, and each card's on-chain stats will shape its champion.";
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
    const b = el("button", "forge", "Play with a neutral champion");
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
// &owned=1 a two-player match accepts only held collection cards (support cards are always free); ranked play
// will need the same check server-side, at match start.
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
  if (DECK) openDeckBuilder(champion); else beginMatch(champion, null);
}

function beginMatch(champion, declaredDeck) {
  session?.close();
  mine = champion;
  const others = snap.cards.filter((c) => c !== champion);
  foeChamp = RELAY || !others.length ? null : others[Math.floor(Math.random() * others.length)];
  const claim = champion ? { tokenId: String(champion.tokenId), stats: toStats(champion.stats) } : undefined;
  session = RELAY
    ? RelaySession.dev(rules, RELAY, q.get("name") ?? `player-${randomSeed().slice(0, 6)}`, claim)
    : new LocalBotSession(rules, randomSeed(), claim?.stats ?? {}, toStats(foeChamp?.stats));
  $("mode").textContent = RELAY ? "Dev relay" : "Practice vs bot";
  pick = null; prev = null; recent = [];
  session.onChange(render);
  $("pick").hidden = true; $("result").hidden = true; $("board").hidden = false;
  if ($("build")) $("build").hidden = true;
  if (declaredDeck) session.declareDeck(declaredDeck);
  render();
}

const act = (x) => { pick = null; session.act(x); };

function describe(def) {
  if (def.type === "unit") return (def.keywords ?? []).join(" · ");
  const e = def.effect ?? {};
  const t = { damage: `Deal ${e.amount}`, heal: `Heal ${e.amount}`, draw: `Draw ${e.amount}`, energy: `+${e.amount} energy`, buff: `+${e.attack ?? 0}/+${e.health ?? 0} to a unit` }[e.op] ?? "";
  return def.type === "relic" ? `Relic · each turn: ${t}` : t;
}

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
  if (unit && !unit.ready) b.classList.add("tired");
  b.setAttribute("aria-label", `${def.name}${def.type === "unit" ? `, ${unit ? unit.atk : def.attack} attack, ${unit ? unit.hp : def.health} health` : ""}${text ? `, ${text}` : ""}`);
  return b;
}

function heroEl(p, champ, label, hurt, onClick) {
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
  wrap.append(face, life, info);
  return wrap;
}

/** One line about what just happened, read from the action against the state before it. */
function narrate(before, s, meIdx) {
  const x = s.last;
  if (!before || !x) return;
  const { op, a, target } = decode(x);
  const actor = before.turn, P = before.p[actor], E = before.p[actor === 0 ? 1 : 0];
  const who = actor === meIdx ? "You" : "Opponent";
  const card = (c) => game.cards[c]?.name ?? "a card";
  const tgt = () => (target === ENEMY_CHAMPION ? (actor === meIdx ? "the enemy champion" : "your champion") : target < 10 ? card(E.board[target - 1]?.c) : target === 10 ? "" : card(P.board[target - 11]?.c));
  let line = "";
  if (op === Op.Play) line = `${who} played ${card(P.hand[a])}${game.cards[P.hand[a]]?.effect?.op === "damage" || game.cards[P.hand[a]]?.effect?.op === "buff" ? ` → ${tgt()}` : ""}`;
  else if (op === Op.Attack) line = `${who}: ${card(P.board[a]?.c)} attacked ${tgt()}`;
  else if (op === Op.End) line = `${who} ended the turn`;
  else if (op === Op.Concede) line = `${s.winner === meIdx ? "Opponent" : "You"} conceded`;
  if (line) recent = [...recent, line].slice(-3);
}

function render() {
  const s = session?.state;
  if (!s) { $("status").textContent = session?.status ?? ""; return; }
  if (s.phase === "decks") {
    // Two-player: waiting for both declarations (the relay fills a missing deck with the suggested one at its deadline).
    for (const id of ["foe-hero", "my-hero", "foe-relics", "my-relics", "foe-lane", "my-lane", "hand"]) $(id).replaceChildren();
    const meIdx = s.p[0].id === session.you ? 0 : 1;
    $("status").textContent = `Declaring decks \u00b7 you ${s.decl[meIdx].length}/${DECK.size} \u00b7 opponent ${s.decl[1 - meIdx].length}/${DECK.size}`;
    $("end").disabled = true;
    return;
  }
  const meIdx = s.p[0].id === session.you ? 0 : 1;
  const me = s.p[meIdx], foe = s.p[meIdx === 0 ? 1 : 0];
  if (s !== prev) narrate(prev, s, meIdx);   // a re-render for a pick is not a new action
  const hurtMe = prev && prev.p[meIdx].life > me.life, hurtFoe = prev && prev.p[meIdx === 0 ? 1 : 0].life > foe.life;
  prev = s;
  const myTurn = !s.over && s.turn === meIdx;
  const legal = myTurn ? rules.legalActions(s) : [];
  const moves = legal.map((x) => ({ x, ...decode(x) }));
  const targets = new Map();   // target code -> action, for the current pick
  if (pick) for (const m of moves) if ((pick.kind === "hand" ? m.op === Op.Play : m.op === Op.Attack) && m.a === pick.index) targets.set(m.target, m.x);

  if (RELAY && !foeChamp) foeChamp = byToken.get(String(session.champions?.[foe.id]?.tokenId)) ?? null;
  const foeHero = heroEl(foe, foeChamp,RELAY ? "Opponent" : "House bot", hurtFoe, targets.has(ENEMY_CHAMPION) ? () => act(targets.get(ENEMY_CHAMPION)) : null);
  $("foe-hero").replaceChildren(...foeHero.childNodes);
  $("foe-hero").dataset.el = foeHero.dataset.el;
  const myHero = heroEl(me, mine, "You", hurtMe, null);
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
    if (!plays.length) { b.classList.add("dead"); return b; }
    b.classList.add("can");
    if (pick?.kind === "hand" && pick.index === index) b.classList.add("picked");
    const aimed = def.type === "spell" && (def.effect?.op === "damage" || def.effect?.op === "buff");
    b.addEventListener("click", () => {
      if (!aimed) { act(plays[0].x); return; }
      pick = pick?.kind === "hand" && pick.index === index ? null : { kind: "hand", index };
      render();
    });
    return b;
  }));

  $("end").disabled = !myTurn;
  $("concede").disabled = s.over;
  const hint = !myTurn ? "" : pick?.kind === "hand" ? `choose a target for ${game.cards[me.hand[pick.index]]?.name}` : pick?.kind === "unit" ? "choose what to attack" : "play cards, attack, or end the turn";
  const status = $("status");
  status.replaceChildren();
  status.append(el("b", null, s.over ? "Match over" : myTurn ? "Your turn" : "Opponent's turn"), ` · turn ${s.turnNo}${hint ? ` · ${hint}` : ""}`);
  if (recent.length) status.append(el("br"), recent.join(" · "));
  if (session.status && !/^practice|^live$/.test(session.status)) status.append(el("br"), session.status);

  if (s.over) {
    $("result-title").textContent = s.winner === 2 ? "Draw" : s.winner === meIdx ? "Victory" : "Defeat";
    $("result-sub").textContent = `${s.turnNo} turns · ${me.life} life left${RELAY ? ` · ${session.status}` : ""}`;
    $("result").hidden = false;
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
$("again").addEventListener("click", () => (lastDeck ? beginMatch(mine, lastDeck) : start(mine)));
$("change").addEventListener("click", () => { session?.close(); session = null; lastDeck = null; $("result").hidden = true; $("board").hidden = true; $("pick").hidden = false; if ($("build")) $("build").hidden = false; });
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
