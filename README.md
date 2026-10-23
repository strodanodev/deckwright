# Deckwright

A lightweight Web3 trading card game maker.

- **One JSON file is a game:** cards, deck, elements, rules.
- **NFTs bring the cards:** a collection's tokens become units, and any token's on-chain **ERC-6699** stats make a champion.
- **Matches are deterministic integer logs:** the browser, the match relay and a **LitNode** ruleset all run the same rules code, so any match can be replayed and settled.

The demo game is **Rapture Duel**, built from the 50 Rapture ARC 1 cards on LitVM Liteforge (chain 4441). Play it at https://deckwright-phi.vercel.app.

Repo: https://github.com/strodanodev/deckwright

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
- **`.claude/skills/deckwright`:** the skill, so an AI agent in the project knows the whole workflow.

### Bring an NFT collection

Any ERC-721 works. ERC-6699 CoreStats make each card's champion; without them, champions are neutral.

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
| `deckwright sim <game.json>` | Bot vs bot: balance numbers and a replay determinism check |
| `deckwright title <game.json> [--litnode <dir>]` | Build the LitNode ruleset; run the built-in (or LitNode's real) conformance checks |
| `deckwright web <game.json> [--collection <cards.json>]` | Build the static site's engine, data and art |
| `deckwright dev` | Serve the site locally, with production headers |
| `TCG_DEV=1 TCG_GAME=<game.json> deckwright relay` | Two-player relay. Open the site twice with `?relay=ws://127.0.0.1:7830&name=alice` and `&name=bob` |

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

A node can therefore host a Deckwright title and settle its matches on chain without changes to the game code. See `.claude/skills/deckwright/references/litnode.md`.

**Not in v1:**
- hidden hands (the duel is open-information);
- more than two players;
- per-player decks from wallet holdings (everyone plays the game's deck; the wallet chooses the champion).

## Working on Deckwright itself

```bash
pnpm install          # also builds dist/ (the CLI)
pnpm deckwright <cmd> # run any command from source (tsx)
pnpm dev              # the demo site at http://127.0.0.1:4173
pnpm test             # rules, ruleset compatibility, EVM decoding, CLI, site bundle
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
games/           game configs
templates/       starter game, LitNode gauntlet config
web/             static site (engine/, data/, assets/art/ are generated by `deckwright web`)
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
