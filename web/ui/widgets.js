// Small shared widgets: the wallet chip, a side crest, and a stat tile.
import { h, icon, toast } from "./dom.js";

/** Connect button, or address and held count once connected. Keeps itself current. Hidden for a game without a collection. */
export function walletChip(app) {
  const label = h("span", { class: "wc-label" });
  const sub = h("span", { class: "wc-sub tabnum" });
  const chip = h("button", { class: "wallet-chip", type: "button", hidden: !app.hasWallet, on: { click: () => void app.toggleWallet().catch((e) => toast(e.message, "err")) } },
    h("span", { class: "wc-ico" }, icon("wallet")), h("span", { class: "wc-text" }, label, sub));
  const render = () => {
    const addr = app.walletShort();
    chip.classList.toggle("on", !!addr);
    label.textContent = addr || "Connect wallet";
    sub.textContent = addr ? `${app.owned.size} held` : app.snap.collection.network || "Liteforge";
  };
  app.onWallet(render);
  render();
  return chip;
}

export function crest(side, cls = "") {
  return h("span", { class: `crest ${side === 0 ? "you" : "foe"} ${cls}` }, icon(side === 0 ? "you" : "foe"));
}

export function tile(value, label) {
  return h("div", { class: "tile" }, h("b", { class: "tabnum", text: value }), h("span", { text: label }));
}
