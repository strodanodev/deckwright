// The meta loop's screens: profile, Gauntlet and daily puzzle. The logic lives in the engine (src/meta); this file
// only draws it. Every name and number goes in through textContent (el()).

const pct = (x) => `${Math.round(x * 100)}%`;
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const STAT_LABEL = { strength: "strength (unit attack)", agility: "agility (opening hand)", resilience: "resilience (life)", intelligence: "intelligence (spell power)" };

/**
 * @param {object} ui  el(tag, cls, text), cardEl(def, opts), champName(tokenId), game, rules
 */
export function createMetaScreens(ui) {
  const { el, cardEl, champName, game } = ui;
  const button = (cls, text, onClick, disabled = false) => {
    const b = el("button", cls, text);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  };
  const tile = (value, label) => { const t = el("div", "tile"); t.append(el("b", null, value), el("span", null, label)); return t; };

  function profile(box, prof, sum, { onWatch, puzzleToday }) {
    box.replaceChildren();
    const tiles = el("div", "tiles");
    tiles.append(
      tile(String(sum.played), "matches"),
      tile(sum.wins + sum.losses ? pct(sum.winRate) : "–", "win rate"),
      tile(String(sum.streak), `win streak · best ${sum.bestStreak}`),
      tile(prof.gauntlet.bestStage ? `${prof.gauntlet.bestStage}/8` : "–", `Gauntlet best · ${prof.gauntlet.cleared} cleared`),
      tile(String(sum.puzzleStreak), `puzzle streak${puzzleToday ? " · today solved" : ""}`),
    );
    box.append(tiles);
    if (sum.byChampion.length) {
      box.append(el("h3", null, "Your champions"));
      const list = el("ol", "champ-records");
      for (const c of sum.byChampion.slice(0, 5)) list.append(el("li", null, `${champName(c.champion)} · ${c.wins}–${c.played - c.wins}`));
      box.append(list);
    }
    box.append(el("h3", null, "Recent matches"));
    if (!prof.matches.length) { box.append(el("p", "lede", "No matches yet. Play one and it shows up here, with its replay.")); return; }
    const table = el("div", "history");
    for (const m of prof.matches.slice(0, 15)) {
      const row = el("div", `hrow ${m.result}`);
      row.append(
        el("span", "h-when", when(m.at)),
        el("span", "h-result", m.result === "win" ? "Win" : m.result === "loss" ? "Loss" : "Draw"),
        el("span", "h-what", `${m.mode === "gauntlet" ? "Gauntlet" : m.mode === "relay" ? "Two-player" : "Practice"}${m.detail ? ` · ${m.detail}` : ""} · vs ${m.opponent ?? "?"}`),
        el("span", "h-turns", `${m.turns} turns`),
      );
      const stale = m.ruleset !== game.litnode.rulesetId;
      if (m.replay) row.append(button("ghost small", stale ? "Old version" : "Watch", () => onWatch(m.replay), stale));
      table.append(row);
    }
    box.append(table);
  }

  function gauntlet(box, run, g, { onFight, onChoose, onNewRun, hasCollection, onStartBase }) {
    box.replaceChildren();
    if (!run) {
      box.append(el("p", "lede", `Eight bot matches, each harder than the last. Win and pick a reward, a better card or a blessing for your champion. Lose once and the run is over. ${hasCollection ? "Pick a champion below to start." : ""}`));
      if (!hasCollection) box.append(button("forge", "Start a run", onStartBase));
      return;
    }
    const stage = Math.min(run.wins + 1, g.stages);
    const pips = el("div", "pips");
    for (let i = 1; i <= g.stages; i++) pips.append(el("i", i <= run.wins ? "won" : i === stage && !run.over ? "next" : ""));
    box.append(pips);
    const blessed = Object.entries(run.blessings).filter(([, v]) => v > 0).map(([k, v]) => `+${Math.round(v / 655.35)}% ${k}`);
    box.append(el("p", "run-line", `${run.champion.tokenId ? champName(run.champion.tokenId) : "Base champion"}${blessed.length ? ` · ${blessed.join(", ")}` : ""}${run.deck.length ? ` · ${run.deck.length}-card deck` : ""}`));
    if (run.over) {
      box.append(el("h3", null, run.cleared ? "Gauntlet cleared!" : `Run over at stage ${stage}`));
      box.append(el("p", "lede", run.cleared ? "All eight beaten. Start another run with a different champion." : `You won ${run.wins} of ${g.stages}. Your best is kept in your profile.`));
      box.append(button("forge", "New run", onNewRun));
      return;
    }
    if (run.offers.length) {
      box.append(el("h3", null, `Stage ${run.wins} won. Choose a reward`));
      const offers = el("div", "offers");
      run.offers.forEach((r, i) => {
        const o = el("div", "offer");
        if (r.kind === "card") {
          o.append(cardEl(game.cards[r.card]), el("p", null, `Replaces ${game.cards[r.replaces]?.name ?? "a card"}`));
        } else {
          o.append(el("div", "bless", "✦"), el("p", null, `Blessing: +${Math.round(r.amount / 655.35)}% ${STAT_LABEL[r.stat]}`));
        }
        o.append(button("forge", "Take it", () => onChoose(i)));
        offers.append(o);
      });
      box.append(offers);
      return;
    }
    const opp = g.opponent(run);
    box.append(el("h3", null, `Stage ${stage}: ${opp.name}`));
    box.append(el("p", "lede", `${opp.tokenId ? champName(opp.tokenId) : "Base champion"} · ${["", "easy", "normal", "hard"][opp.level]} bot${opp.deck.length ? " · a stronger deck each stage" : ""}`));
    const row = el("div", "deck-bar");
    row.append(button("forge", "Fight", onFight), button("ghost", "Abandon run", onNewRun));
    box.append(row);
  }

  function puzzle(box, p, solved, { onPlay, generating }) {
    box.replaceChildren();
    if (generating) { box.append(el("p", "lede", "Setting up today's puzzle…")); return; }
    if (!p) { box.append(el("p", "lede", "No puzzle today: try again tomorrow.")); return; }
    const stars = p.odds <= 0.03 ? 3 : p.odds <= 0.12 ? 2 : 1;
    box.append(el("p", "lede", "Win this turn. Every player gets the same position today; it is always winnable. End your turn without winning and you can retry."));
    box.append(el("p", "run-line", `${p.date} · difficulty ${"★".repeat(stars)}${"☆".repeat(3 - stars)} · the bot won in ${p.par} actions`));
    if (solved) box.append(el("p", "solved", `Solved in ${solved.actions} actions. Come back tomorrow for the next one.`));
    box.append(button("forge", solved ? "Play again" : "Play today's puzzle", onPlay));
  }

  return { profile, gauntlet, puzzle };
}
