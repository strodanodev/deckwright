---
name: deckwright
description: Build a complete Web3 trading card game with Deckwright — from scratch (a themed card set) or from any NFT collection on chain — and ship it as a playable, deployable web game. One JSON file is the game; ERC-6699 token stats become champions; players can bring wallet decks; bots balance it; the same deterministic rules run in the browser, a two-player relay and LitNode. Use when the user asks to make, design, rebalance, theme, test or deploy a card game / TCG / CCG, turn NFTs into playable cards, or work in a Deckwright project.
---

# Deckwright: build a card game

Work through this in order and don't stop at a plan: the deliverable is a game that runs. A fresh request ("make me a pirate TCG") should end with a project that has:
- a themed, balanced card set;
- passing checks;
- a site that plays in the browser.

Ask the user only if something is genuinely blocking. Otherwise choose sensible defaults, say what you assumed, and keep going.

## 0. Before you start

- **Tools:** you need Node 22+, plus git (npx installs Deckwright from GitHub). Check with `node --version`.
- **Inputs to settle**, from the request or by default:

| Input | Default |
|---|---|
| Game title and id (kebab-case) | from the theme, for example `pirate-duel` |
| Theme: 3–5 elements and a flavour for names | from the request |
| Cards | 18–24 distinct cards |
| NFT collection (an address and chain)? | none: build from scratch |
| Wallet decks (players bring their own decks)? | only with a collection |

## 1. Create the project

```bash
npx github:strodanodev/deckwright create <game-id> --title "<Game Title>"
cd <game-id>
npm install
```

- Once Deckwright is on npm, `npx deckwright create …` does the same.
- `create` writes these files:
  - `games/<id>.game.json`: the game; you'll rewrite it.
  - `web/`: the site, with a built engine.
  - `vercel.json` and `gauntlet.json`.
  - this skill, in `.claude/skills/`.
- Inside the project, run every command as `npx deckwright <cmd>`. It's a local dependency.

## 2. Design the game (`games/<id>.game.json`)

Rewrite the starter's `title`, `description`, `elements`, `cards` and `deck` to fit the theme. Keep the `litnode`, `champion` and `rules` blocks unless you have a reason to change them.

Design by the numbers in **[references/design-guide.md](references/design-guide.md)**: the cost curve, the stat budget per cost, keyword prices, the deck mix, and element cycles. Every field and limit is in **[references/game-config.md](references/game-config.md)**.

Hard rules: the validator rejects anything else, with a clear message.
- **Ids:** card and element ids are kebab-case and unique; `element` must be one of `elements[].id`.
- **Units:** `attack` 0–99 and `health` 1–99. `keywords` from `guard`, `haste`, `rush`, `lifesteal`, `shield`, `poison`, `elusive`. Up to 3 `abilities`: `{ "on": "play" | "death" | "turnStart" | "attack", "effect": … }`.
- **Spells and relics:** each has one `effect`: `damage`, `heal`, `draw`, `energy` (with `amount`), `buff` (`attack`, `health`), `shield`, or `summon` (`card`, `count`). Add `"target"` to aim it, such as `"all-enemy-units"`. Relics and non-`play` abilities take automatic targets only.
- **Hero powers:** `champion.powers`, chosen per champion by its card's `element` (or `kind`, or highest `stat`), with one unconditioned default.
- Every op, target and keyword is in game-config.md; prices are in design-guide.md. Give the set interaction: removal, a few area effects, keywords on a third of the units.
- **Deck:** `deck` is `{ cardId: copies }` with 5–120 cards in total.
- **Version:** `litnode.rulesetId` is `<id>.v1`. Bump it to `.v2` and up on any rules or card change after a release.
- **Art (optional):** a card's `art` can point to a local image, for example `"./assets/cards/kraken.webp"` under `web/`. The site's CSP serves same-origin images only. With no art, cards show an element glyph, and that's fine.

## 3. Balance it

```bash
npx deckwright sim games/<id>.game.json --matches 300
```

Iterate until the sim meets these targets. Each pass is a JSON edit plus a re-run.

| Output | Target | If not |
|---|---|---|
| `replay mismatches` | **0** (required) | Something non-deterministic was added: undo it |
| `first player wins` | 45–55% | Above 55%: raise `rules.secondPlayerCards` by 1 (fine) or `rules.secondPlayerEnergy` by 1 (coarse), or make the deck larger. Below 45%: lower them |
| `hit maxTicks` | about 0% | Add damage at higher costs, or raise `litnode.maxTicks` |
| `avg turns` | 8–16 | Too short: more health and cheaper healing. Too long: more attack and fewer `guard` |
| `never played` | few cards | Cheapen or strengthen them, or cut them |

The sim then prints **fun targets**. They are signals that the set plays as more than a race of plain creatures. Get every one to ✓:

| Target | Want | If not |
|---|---|---|
| attacks at the champion | at most 85% | More guards, rush, removal, and units worth trading |
| spells, relics, powers | at least 15% of plays | More spells; add hero powers |
| board leader wins | at least 50% | Boards must matter: more abilities, fewer haste face-hitters |
| champion edge wins | at most 62% | Narrow the `champion` ranges |
| close finishes | at least 15% | Lower starting life; fewer heals |
| match length spread | at least ±2 turns | More variety in the curve and effects |

`--strict` makes any miss (and first-player wins outside 45–55%) exit 1.

## 4. Optional: build it from an NFT collection

Any ERC-721 works. ERC-6699 `coreStats` make champions; without them, champions are neutral.

```bash
npx deckwright snapshot <address> --chain liteforge --out collection
npx deckwright import collection/cards.json --id <game-id> --out games
```

`import` applies the design kit: each element gets an archetype (aggro, control, defense, value), units get its keywords and abilities by tier, and each element gets spells, a relic and a hero power. `--plain` gives bare stat lines instead.

- **`snapshot`:** for chains other than Liteforge, use `--rpc <url>` and, if the chain has a Blockscout explorer, `--explorer <url>`. It downloads the art.
- **`import`:** rewrites `games/<id>.game.json` from the collection. Then apply step 2's theming to the support cards and step 3's balancing.
- **Wallet decks** (players bring the cards they own): add `"deckRules": { "mode": "declared", "size": 30, "maxCopies": 2 }`. The default `deck` must hold at least `size` cards.
- **Balance wallet decks too:** run `npx deckwright sim games/<id>.game.json --matches 1000 --decks random` as well as the default. Both must meet step 3's targets. Random decks play every card, and the sim lists the strongest and weakest cards. Smaller decks favour the first player.
- **Rights:** the Rapture characters (`0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721`) are © LitVM Games. A game meant for release needs permission (see [references/pipeline.md](references/pipeline.md)). Prototypes are fine.

## 5. Check LitNode compatibility

```bash
npx deckwright title games/<id>.game.json
```

It must end `ok`. That means the game can later be hosted and settled on LitNode unchanged.

## 6. Build and play the site

```bash
npx deckwright web games/<id>.game.json            # add --collection collection/cards.json if you did step 4
npx deckwright dev                                 # serves http://127.0.0.1:4173 (use 127.0.0.1, not localhost)
```

- Run `dev` in the background.
- Open the site, pick a champion, and play at least one full turn against the bot:
  - play a card;
  - attack;
  - end the turn;
  - check the browser console has no errors.
- To restyle it to the theme:
  - `web/app.css`: the `:root` colour tokens and fonts (element colours come from `elements[].color` in the game file);
  - `web/index.html`: text, title, description.
- Keep the page's safety rules:
  - no inline `<script>` (the CSP blocks it), so logic stays in `web/app.js`;
  - card and collection names go in through `textContent` only, never `innerHTML`.
- Re-run `deckwright web` after every game JSON change; it regenerates `web/engine`, `web/data` and the art.

## 7. Two players (optional check)

```bash
TCG_DEV=1 TCG_GAME=games/<id>.game.json npx deckwright relay     # ws://127.0.0.1:7830, one match per process
```

Open `http://127.0.0.1:4173/?relay=ws://127.0.0.1:7830&name=alice` and `…&name=bob` in two tabs. Pick champions; with wallet decks, build or suggest a deck. Play a turn in each tab.
- The relay reads champion stats from the chain, never from the page. With no network, add `TCG_CHAIN=off`: champions then fight with base stats.
- **Owned-only test:** add `TCG_OWNED=1` to the relay and `&owned=1` to both URLs, and connect a wallet. The relay rejects collection cards that wallet doesn't hold.

## 8. Deliver

Report back to the user with:
- what you built: theme, card count, mechanics, deck rules;
- the final sim numbers;
- the exact commands to play locally;
- how to deploy: `vercel deploy --prod` from the project root, or any static host serving `web/` with the headers in `vercel.json`.

List what you assumed, and anything left undone.

## Rules that keep matches replayable

Don't break these when extending Deckwright itself.
- **The rules core is pure and integer-only.**
  - No `Math.random`, `Date`, timers, `fetch`, `WebSocket`, storage, `crypto.`, `process.env` or `import()`, not even as words in strings.
  - Randomness comes only from `seededRandom(seed)`.
- **Log shape:** two players, one integer action per log entry. Illegal actions are no-ops, never throws, and `maxTicks` bounds a match.
- **Champions:** stats arrive as `ctx.agents[player].stats`; with no champion, or a missing stat, it is 0, exactly as LitNode hydrates it. Every surface goes through `normalizeStats` (`src/core/champion.ts`); never add a different default.
- **Ownership is not a rule:** the rules accept any declared card. The relay enforces owned-only decks (`src/tools/chain-check.ts`).
- **Open information:** v1 has no hidden hands. Commit-reveal or ZK would be a new ruleset version.
- **Draws** come from the seed plus the entropy of accepted actions up to the turn start, never from deck order alone, so nobody can read draws ahead of the game.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid game config: …` | Read the listed problems; each names the field. Limits are in game-config.md |
| `npx github:…` hangs or fails | Needs git and network. Retry, or use `npm i -D github:strodanodev/deckwright` and then `npx deckwright` |
| Site blank, console CSP error | Something was inlined or loaded from another origin. Move it into `web/` or `app.js` |
| `snapshot` slow or `429` | The public RPC throttles; the tool waits and retries. Explorer-backed chains are faster |
| Art missing after `web` | Remote art is dropped by design: re-run `snapshot` (it downloads), or use local `art` paths |

## Extending Deckwright (in its own repo)

The source is at https://github.com/strodanodev/deckwright: `src/core` (rules), `src/client` (sessions), `src/tools` (CLI). To add an effect op:
1. Add it to the `Effect` union in `src/core/types.ts`.
2. Add one entry to `OPS` in `src/core/effects.ts`: field checks, allowed targets, default target, resolution (through `Fx`) and card text. Validation, legal actions, the bot, the sim and the client's card text pick it up from there.
3. If it needs a new engine primitive, add it to `Fx` and implement it in `fxFor()` in `src/core/rules.ts`.
4. Re-run `pnpm test`, `pnpm sim`, `pnpm title` and `pnpm web`.

A keyword is an entry in `KEYWORDS` (effects.ts) plus its check where it acts in rules.ts (`hit()` for damage keywords, `act()` for attack rules).

LitNode hosting (deferred) is in [references/litnode.md](references/litnode.md).
