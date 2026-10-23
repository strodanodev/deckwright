// Deckwright (carried over from the FORGE hall) — pack tiers and finishes, kept free of three.js so plain modules (and their Node tests) can use them.
// Rapture has no rarity: Kind is the only tier. The pack's ladder (frame colour, flip FX) follows it.
export const RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
export const RARITY = {
  common: { label: "COMMON", css: "#c9d2dc", glow: 0xbcd0ff, fx: 0.5 },
  rare: { label: "RARE", css: "#46a6ff", glow: 0x3f9dff, fx: 0.8 },
  epic: { label: "EPIC", css: "#b76bff", glow: 0xa455ff, fx: 1.1 },
  legendary: { label: "LEGENDARY", css: "#ffbf3f", glow: 0xffae2a, fx: 1.7 },
};

// PackShopV2 prints every card in a finish, fixed in the deck (deck.js). A card carries `finish`: "normal" | "shiny" |
// "gold", or null for a token this shop did not mint. Gold is gold leaf (filigree, flecks, a slow gold shimmer); Shiny
// is a prismatic foil whose rainbow rolls with the viewing angle. badge is the label the panel and the Library show.
export const FINISH = Object.freeze({
  normal: Object.freeze({ id: 1, label: "Normal", rank: 0, badge: null, mark: "" }),
  shiny: Object.freeze({ id: 2, label: "Shiny", rank: 1, badge: "✧ Shiny", mark: "✧" }),
  gold: Object.freeze({ id: 3, label: "Gold", rank: 2, badge: "✦ Gold", mark: "✦" }),
});
/** The contract's Finish enum value (1 Normal, 2 Shiny, 3 Gold; 0 = not a v2 card) -> the key above, or null. */
export const finishKey = (id) => ["normal", "shiny", "gold"][Number(id) - 1] ?? null;
/** Crescendo order inside a pack: Kind tier first, then finish, so a Gold card flips after a plain one of its tier. */
export const cardRank = (c) => RANK[c.rarity] * 3 + (FINISH[c.finish]?.rank ?? 0);
