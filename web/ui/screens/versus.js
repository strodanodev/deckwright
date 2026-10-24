// The match loader (Rapture Chess's versus screen): both champions crash in from the sides, the VS flashes, and a
// gilded bar fills while the match sets up. A two-player match waits here for the opponent.
import { h, icon } from "../dom.js";
import { crest } from "../widgets.js";

const TIPS = [
  "A champion's resilience sets its life, intelligence its spell power, strength its units' attack, agility its opening hand.",
  "Guard units must be attacked first. Plan your lethal around them.",
  "Every match is a replayable record: share it from the result screen.",
  "Elements beat each other in a cycle: the stronger element deals bonus damage.",
  "Your hero power is once per turn and never leaves your hand.",
  "Press Esc in battle for the battle menu.",
  "In the Gauntlet, one loss ends the run. Choose your rewards with the next foe in mind.",
];

export function versusScreen(app) {
  const side = (s) => {
    const art = h("img", { class: "vs-art", alt: "", decoding: "async" });
    const name = h("span", { class: "vs-name display" });
    const sub = h("span", { class: "vs-sub" });
    const el = h("div", { class: `vs-side ${s === 0 ? "you" : "foe"}` }, art, h("div", { class: "vs-id" }, crest(s, "lg"), name, sub));
    return { el, art, name, sub };
  };
  const a = side(0), b = side(1);
  const bar = h("i");
  const label = h("span", { class: "vs-status" });
  const tip = h("p", { class: "vs-tip" });
  const realm = h("span", { class: "eyebrow" });
  const el = h("section", { class: "versus", aria: { label: "Loading the match", busy: "true" } },
    a.el, b.el,
    h("div", { class: "vs-mark" }, h("div", { class: "vs-flash" }), h("span", { class: "gilded", text: "VS" })),
    h("div", { class: "vs-foot" }, realm, h("div", { class: "vs-bar" }, bar), label, tip, h("span", { class: "vs-rune" }, icon("rune"))));

  return {
    id: "versus", el, noBack: true,
    /** info: { names: [you, foe], subs: [you, foe], champs: [card|null, card|null], realm } */
    show(info) {
      [a, b].forEach((s, i) => {
        const c = info.champs[i];
        s.art.hidden = !c?.art;
        if (c?.art) { s.art.src = c.art; s.art.alt = c.name; }
        s.name.textContent = info.names[i];
        s.sub.textContent = info.subs[i];
      });
      realm.textContent = `Battlefield · ${info.realm}`;
      tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      bar.style.transform = "scaleX(0)";
      el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
    },
    progress(p, text) { bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`; label.textContent = text; },
    enter() { app.arena.setMood("battle"); },
  };
}
