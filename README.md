# Deckwright

A lightweight Web3 trading card game maker.

- **One JSON file is a game:** cards, deck, elements, rules.
- **NFTs bring the cards:** a collection's tokens become units, and any token's on-chain **ERC-6699** stats make a champion.
- **Matches are deterministic integer logs:** the browser, the match relay and a **LitNode** ruleset all run the same rules code, so any match can be replayed and settled.

The demo game is **Rapture Duel**, built from the 50 Rapture ARC 1 cards on LitVM Liteforge (chain 4441). Play it at https://deckwright-phi.vercel.app.

Repo: https://github.com/strodanodev/deckwright

## Use it with Claude Code (one-shot game building)

Install the plugin, then ask for a game, for example "make me a pirate trading card game". The `deckwright` skill creates the project, designs and balances the card set, builds the site and plays a turn to check it.

```text
/plugin marketplace add strodanodev/deckwright
/plugin install deckwright@deckwright
```

From a shell: `claude plugin marketplace add strodanodev/deckwright`, then `claude plugin install deckwright@deckwright`. Run the skill directly with `/deckwright:deckwright`.

## Start a game (builders)

```bash
npx github:strodanodev/deckwright create my-tcg   # scaffolds a project and builds its site
cd my-tcg && npm install
npm run dev                        # http://127.0.0.1:4173 — play it against the bot
```

Until the package is on npm, run it straight from GitHub:

```bash
npx github:strodanodev/deckwright create my-tcg
```

The new project then depends on `github:strodanodev/deckwright`. For a local copy, use `npx --package <path to deckwright-x.y.z.tgz> deckwright create my-tcg --sdk file:<path>`.

The new project contains:
- **`games/<id>.game.json`:** the game.
- **`web/`:** the site.
- **`vercel.json`:** deploy config and CSP.
- **`gauntlet.json`:** LitNode hosting, for later.
- **`.claude/skills/deckwright`:** the skill, so an AI agent opened in the project knows the whole workflow (the same skill the plugin ships).

### Bring an NFT collection

Any ERC-721 works. ERC-6699 CoreStats make each card's champion; without them, every champion fights with base stats (all 0).

```bash
npx deckwright snapshot <collection address> --chain liteforge --out collection    # or --rpc <url> [--explorer <blockscout url>]
npx deckwright import collection/cards.json --id my-tcg --out games
npx deckwright web games/my-tcg.game.json --collection collection/cards.json
```

What `snapshot` does:
- **Finding tokens:** it lists tokens through a Blockscout explorer when there is one; otherwise it reads the mint `Transfer` logs (pass `--from-block` on long chains).
- **Editions:** tokens that share one design (pack editions) are kept once.
- **Art:** it downloads the art, so the site serves it under its own CSP. IPFS goes through several gateways.

What `import` does:
- **Kind:** it maps Rapture Kinds when present.
- **Cost and rarity:** otherwise, they come from stat-power quintiles.
- **Elements:** they form a cycle.
- **Support cards:** neutral spells and relics are added.

## Commands

| Command | What it does |
|---|---|
| `deckwright create <dir>` | Scaffold a game project |
| `deckwright new <id>` | Add a game config from the template |
| `deckwright snapshot <address>` | Read an NFT collection (and its ERC-6699 stats) from chain |
| `deckwright import <cards.json> --id <id>` | Turn a collection into a card set |
| `deckwright sim <game.json> [--decks random]` | Bot vs bot: balance numbers and a replay determinism check. `--decks random` balances wallet decks and rates every card |
| `deckwright title <game.json> [--litnode <dir>]` | Build the LitNode ruleset; run the built-in (or LitNode's real) conformance checks |
| `deckwright web <game.json> [--collection <cards.json>]` | Build the static site's engine, data and art |
| `deckwright dev` | Serve the site locally, with production headers |
| `deckwright replay <link \| code \| record.json>` | Replay a shared match and print its result, scores and final-state digest |
| `TCG_DEV=1 TCG_GAME=<game.json> deckwright relay` | Two-player relay. Open the site twice with `?relay=ws://127.0.0.1:7830&name=alice` and `&name=bob`. It reads champion stats from the chain (`TCG_CHAIN=off` to skip); `TCG_OWNED=1` enforces owned-only decks |

## How a match works

```
seed + champions ─► init ─► step(entry 0) ─► step(entry 1) ─► … ─► done → scores
```

- **One action per log entry:** a 32-bit integer from the acting player; the other side sends 0.
- **Illegal actions are no-ops**, so any log replays.
- **Turn clock and disconnects:** the relay orders the actions, ends a turn when the clock runs out, and concedes for a player who stays disconnected.

**LitNode (planned).** The relay already speaks LitNode's gauntlet interface:
- `GAUNTLET_*` environment variables;
- HMAC seat tickets;
- a signed `/ledger` submission.

A node can therefore host a Deckwright title and settle its matches on chain without changes to the game code. See `plugin/skills/deckwright/references/litnode.md`.

**Wallet decks** (`deckRules.mode: "declared"`): each player builds a deck, for example from the cards their wallet holds.
- The deck is declared card by card at the start of the match log, so any node replays it.
- Decks are shuffled from the match seed.
- The demo does this with 36-card decks.
- Owned-only matches (`TCG_OWNED=1`, the default for ranked) are enforced by the relay: it reads the wallet's holdings on chain and rejects any other collection card. The rules themselves accept any card, so casual play is open.
- The relay also reads each champion's stats on chain and ignores what the client claims. A player with no champion fights with base stats (all 0), as LitNode hydrates them.

**Mechanics:** seven keywords (guard, haste, rush, lifesteal, shield, poison, elusive); abilities that fire on play, death, turn start or attack; seven effect ops with chosen or automatic targets; hero powers per champion (by element, kind or highest stat). `import` gives a collection all of these through its design kit, and `sim` checks balance and fun targets.

**The meta loop** (all offline, in the browser):
- **Profile:** wins, streaks, a record per champion, and recent matches with their replays. It's kept in the browser's local storage.
- **Gauntlet:** eight bot matches of rising difficulty. Win and pick a reward: a better card for your deck, or a blessing (a stat boost) for your champion. Lose once and the run is over.
- **Daily puzzle:** "win this turn". The puzzle is the same for every player on a date and always winnable, and a solution is a replayable record.
- None of it changes the rules: blessings are champion stats passed to `init`, so every match still replays under the game's `rulesetId`.

**Replays and spectators.** A match is fully described by its record: the ruleset, the seed, the players, their champions and the input log. That is what LitNode replays.
- **Share replay** turns a finished match into a link. The record rides in the URL fragment (`#replay=…`), so no server stores it, and anyone with the link watches the match move by move.
- `deckwright replay "<link>"` replays a link from the command line and prints the result.
- Spectators join a relay match with `?relay=<ws url>&watch=1`. They see every move and can't act. `TCG_WATCH_DELAY_MS` delays them, and is 2 minutes in ranked by default.

**Not in v1:**
- hidden hands (the duel is open-information);
- more than two players.

## Working on Deckwright itself

```bash
pnpm install          # also builds dist/ (the CLI)
pnpm deckwright <cmd> # run any command from source (tsx)
pnpm dev              # the demo site at http://127.0.0.1:4173
pnpm test             # rules, ruleset compatibility, EVM decoding, chain checks, relay, CLI, site bundle
pnpm typecheck
```

The demo site was built with:

```bash
pnpm snapshot 0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721 --chain liteforge --out collection
pnpm web games/rapture-duel.game.json --collection collection/cards.json
```

Layout:

```
src/core/        pure rules engine (no DOM, Node, clock or randomness)
src/client/      match sessions: vs bot, relay, LitNode arcade bridge
src/litnode/     LitNode title adapter
src/tools/       the commands (cli.ts dispatches to them)
plugin/          the Claude Code plugin: skills/deckwright (SKILL.md + references), .claude-plugin/plugin.json
.claude-plugin/  marketplace.json (this repo is the plugin's marketplace)
games/           game configs
templates/       starter game, LitNode gauntlet config
web/             the game client: app.js wires the flows, ui/ has the screens, arena and cards, styles/ the design;
                 engine/, data/ and assets/art/ are generated by `deckwright web`
adapters/        optional Genesys engine HUD + scene node
test/            node:test suites
```

`package.json` keeps `"private": true` so nothing is published to npm by accident. Remove it when the package is ready to publish.

## License

- **Code:** Apache-2.0 (`LICENSE`).
- **Rapture demo content** (character art, names, collection snapshot): not covered. © LitVM Games, all rights reserved. See `NOTICE`.

## Deploy

The site is static: `web/` plus the headers in `vercel.json` (CSP included). Any static host works. On Vercel:

```bash
vercel deploy --prod
```

There is no build step on the host. Rebuild with `deckwright web` and commit the generated `web/engine`, `web/data` and `web/assets/art` before deploying.
