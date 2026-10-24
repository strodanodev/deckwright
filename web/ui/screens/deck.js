// The deck forge (declared-deck games): every card on the left, your deck, its mana curve and the start button on the
// right. Any card may be played in practice and casual matches; with &owned=1 the forge offers only held collection
// cards (support cards are always free), as the relay will enforce (TCG_OWNED=1).
import { h, icon, stagger } from "../dom.js";
import { pageHead } from "../router.js";
import { walletChip } from "../widgets.js";

const TYPES = [["all", "All"], ["unit", "Units"], ["spell", "Spells"], ["relic", "Relics"]];

export function deckScreen(app) {
  const { game, rules } = app;
  const D = game.deckRules;
  const key = `deckwright.deck.${game.litnode.rulesetId}`;
  let deck = [], type = "all", onDone = null;
  const tokenOf = (def) => (def.token ? String(def.token.tokenId) : null);
  const allowed = (def) => !app.requireOwned || !tokenOf(def) || app.owned.has(tokenOf(def));
  const copies = (i) => deck.filter((d) => d === i).length;
  const room = (i) => allowed(game.cards[i]) && copies(i) < D.maxCopies && deck.length < D.size;

  const grid = h("div", { class: "forge-grid" });
  const typeSeg = h("div", { class: "seg" });
  const list = h("ol", { class: "deck-list" });
  const curve = h("div", { class: "curve", aria: { label: "Mana curve" } });
  const count = h("b", { class: "tabnum" });
  const meter = h("i");
  const start = h("button", { class: "btn primary lg block pulse", type: "button", on: { click: () => finish() } }, icon("swords"), "To battle");
  const btn = (text, ico, onClick) => h("button", { class: "btn ghost sm", type: "button", on: { click: onClick } }, icon(ico), text);
  const walletBtn = btn("Wallet deck", "wallet", () => {
    deck = [];
    game.cards.forEach((def, i) => { if (tokenOf(def) && app.owned.has(tokenOf(def))) while (room(i)) deck.push(i); });
    game.cards.forEach((def, i) => { if (!tokenOf(def)) while (room(i)) deck.push(i); });
    for (const i of rules.game.suggestedDeck) if (room(i)) deck.push(i);
    render();
  });
  const rule = h("p", { class: "hint" });

  function suggest() {
    deck = [];
    for (const i of rules.game.suggestedDeck) if (room(i)) deck.push(i);
    for (const i of rules.game.deckList) if (room(i)) deck.push(i);
    for (let i = 0; i < game.cards.length && deck.length < D.size; i++) while (room(i)) deck.push(i);
  }

  function render() {
    typeSeg.replaceChildren(...TYPES.map(([v, label]) => h("button", { type: "button", class: type === v ? "on" : "", text: label, on: { click: () => { type = v; render(); } } })));
    grid.replaceChildren(...game.cards.map((def, i) => [def, i]).filter(([def]) => type === "all" || def.type === type).sort((a, b) => a[0].cost - b[0].cost || a[0].name.localeCompare(b[0].name)).map(([def, i]) => {
      const ok = allowed(def), n = copies(i);
      const face = app.cards.cardFace(def, { tag: "button" });
      face.disabled = !ok;
      face.addEventListener("click", () => {
        if (room(i)) { deck.push(i); render(); return; }
        app.toast(deck.length >= D.size ? `The deck is full: remove a card first` : `Up to ${D.maxCopies} copies of a card`);
      });
      const held = tokenOf(def) && app.owned.has(tokenOf(def));
      return h("div", { class: `forge-tile${ok ? "" : " locked"}${n ? " in" : ""}` }, face,
        h("div", { class: "ft-bar" },
          h("button", { class: "icon-btn sm", type: "button", disabled: !n, aria: { label: `Remove ${def.name}` }, on: { click: () => { deck.splice(deck.lastIndexOf(i), 1); render(); } } }, h("span", { class: "minus", text: "−" })),
          h("span", { class: "ft-n tabnum", text: `${n}/${D.maxCopies}` }),
          h("span", { class: `ft-note${held ? " held" : ""}`, text: !ok ? "Not in wallet" : held ? "Held" : tokenOf(def) ? "" : "Support" })));
    }));
    // The deck: one row per card, cheapest first, and the curve by cost (7+ in the last bar).
    const counts = new Map();
    for (const i of deck) counts.set(i, (counts.get(i) ?? 0) + 1);
    list.replaceChildren(...[...counts.entries()].sort((a, b) => game.cards[a[0]].cost - game.cards[b[0]].cost || game.cards[a[0]].name.localeCompare(game.cards[b[0]].name)).map(([i, n]) => {
      const def = game.cards[i];
      return h("li", { style: `--el:${app.elementColor(def.element)}`, data: { rarity: def.rarity ?? "common" } },
        h("span", { class: "dl-cost tabnum", text: def.cost }), h("span", { class: "dl-name", text: def.name }), h("span", { class: "dl-n tabnum", text: `×${n}` }),
        h("button", { class: "dl-x", type: "button", aria: { label: `Remove ${def.name}` }, on: { click: () => { deck.splice(deck.lastIndexOf(i), 1); render(); } } }, icon("close")));
    }));
    if (!deck.length) list.append(h("li", { class: "empty", text: "Click cards to add them, or take the suggested deck." }));
    const bars = Array.from({ length: 8 }, () => 0);
    for (const i of deck) bars[Math.min(7, game.cards[i].cost)]++;
    const top = Math.max(1, ...bars);
    curve.replaceChildren(...bars.map((n, c) => h("div", { class: "cv" }, h("i", { style: `--v:${Math.round((n / top) * 100)}%`, title: `${n} at cost ${c}${c === 7 ? "+" : ""}` }), h("span", { text: c === 7 ? "7+" : String(c) }))));
    count.textContent = `${deck.length} / ${D.size}`;
    meter.style.setProperty("--v", `${Math.round((deck.length / D.size) * 100)}%`);
    start.disabled = deck.length !== D.size;
    walletBtn.hidden = app.owned.size === 0;
  }

  function finish() {
    if (deck.length !== D.size) return;
    try { localStorage.setItem(key, JSON.stringify(deck)); } catch { /* private mode: the deck just isn't remembered */ }
    onDone?.(deck.slice());
  }

  const el = h("section", { class: "page forge-page" },
    h("div", { class: "page-scrim" }),
    pageHead("Forge your deck", `${D?.size ?? 0} cards · up to ${D?.maxCopies ?? 0} of each`, walletChip(app)),
    h("div", { class: "forge-wrap" },
      h("div", { class: "forge-cards" }, typeSeg, grid),
      h("aside", { class: "deck-panel panel frame" },
        // on a phone the panel is a sheet along the bottom: the head opens the list, To battle always shows
        h("div", { class: "panel-head" }, h("h2", { text: "Your deck" }), h("span", { class: "deck-count" }, count),
          h("button", { class: "icon-btn sm sheet-toggle", type: "button", aria: { label: "Show the deck list", expanded: "false" }, on: { click: (e) => { const open = e.currentTarget.closest(".deck-panel").classList.toggle("open"); e.currentTarget.setAttribute("aria-expanded", String(open)); } } }, icon("next"))),
        h("div", { class: "panel-body" },
          h("div", { class: "meter deck-meter" }, meter),
          curve,
          list,
          rule,
          h("div", { class: "deck-tools" }, btn("Suggested", "spark", () => { suggest(); render(); }), walletBtn, btn("Clear", "close", () => { deck = []; render(); }))),
        h("div", { class: "panel-foot" }, start))));
  app.onWallet(() => { if (!el.hidden) render(); });

  return {
    id: "deck", el,
    /** Open for a champion; `done(deck)` runs with the finished deck (card indices). */
    open(done) {
      onDone = done;
      try { deck = JSON.parse(localStorage.getItem(key) ?? "[]").filter((i) => Number.isInteger(i) && game.cards[i]); } catch { deck = []; }
      deck = deck.filter((i) => allowed(game.cards[i])).slice(0, D.size);
      if (!deck.length) suggest();
      rule.textContent = app.requireOwned ? "Owned-only match: collection cards must be in your wallet; support cards are always available." : "Any card may be played in practice and casual matches. Cards your wallet holds are marked, and Wallet deck builds from them.";
    },
    enter() { app.arena.setMood("menu"); render(); stagger(grid); },
  };
}
