// "Build your own": the demo site's pitch for Deckwright itself. It shows only when index.html carries the funnel
// marker (<meta name="deckwright-funnel">), which `deckwright create` strips from scaffolded games.
import { copyText, h, icon, stagger } from "../dom.js";
import { pageHead } from "../router.js";

const STEPS = [
  ["Create a game", "npx github:strodanodev/tessaract create my-tcg", "Scaffolds a playable game, this site, and an AI skill that knows the whole workflow."],
  ["Bring a collection", "npx deckwright snapshot <collection address> --chain liteforge", "Reads any ERC-721 from chain: names, art and ERC-6699 stats. Then import makes the cards."],
  ["Balance, play, ship", "npm run sim && npm run dev", "Bot-vs-bot balance numbers, a local site, then one static deploy. LitNode-ready rulesets for on-chain settlement."],
];

export function forgeScreen(app) {
  const steps = h("ol", { class: "steps" }, ...STEPS.map(([t, cmd, text], i) => {
    const copy = h("button", { class: "icon-btn sm", type: "button", title: "Copy command", aria: { label: "Copy command" } }, icon("scroll"));
    copy.addEventListener("click", () => void copyText(cmd));
    return h("li", { class: "panel frame step" },
      h("span", { class: "step-n display", text: String(i + 1) }),
      h("h3", { class: "display", text: t }),
      h("div", { class: "cmd" }, h("code", { text: cmd }), copy),
      h("p", { class: "hint", text }));
  }));
  const el = h("section", { class: "page forge-funnel" },
    h("div", { class: "page-scrim" }),
    pageHead("Build your own", "Open source · Apache-2.0"),
    h("div", { class: "page-wrap funnel-wrap" },
      h("p", { class: "lede funnel-lede", text: "This duel is one JSON file. Deckwright turns any NFT collection into a card set, its on-chain ERC-6699 stats into champions, and gives you the rules engine, a bot, two-player play, replays and this whole game client, ready to deploy." }),
      steps,
      h("div", { class: "funnel-links" },
        h("a", { class: "btn primary", href: "https://github.com/strodanodev/tessaract", rel: "noopener" }, icon("code"), "Get Deckwright"),
        h("a", { class: "btn ghost", href: "https://github.com/strodanodev/tessaract#readme", rel: "noopener" }, icon("scroll"), "Read the guide")),
      h("p", { class: "hint fine" }, "Rapture characters in this demo are © LitVM Games and not part of the open-source license. To use them in your own game, ",
        h("a", { href: "https://github.com/strodanodev/tessaract/issues/new?labels=rapture-license&title=Rapture%20character%20use%20request", rel: "noopener", text: "request permission" }), ".")));
  return { id: "forge", el, enter() { app.arena.setMood("menu"); stagger(steps); } };
}
