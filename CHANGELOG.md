# Changelog

Every rules or card change ships under a new `rulesetId`, so a game built on an older Deckwright keeps replaying exactly as it did.

## 0.5.0 (2026-10-24): replays and spectators

No rules change: every ruleset replays exactly as before.

**Replays**
- Match records (`src/client/replay.ts`): the ruleset, seed, players, hydrated champions and input log. That is exactly what LitNode replays, so a record is also proof of a result.
- Share links: the record is compressed into the URL fragment (`#replay=…`), which browsers never send to a server.
- Every session has `record()`. The new `ReplaySession` rebuilds every state with the same rules and moves by move or by turn.
- Links are untrusted input: sizes are capped, shapes are checked, stats are normalized, and a record from another ruleset is refused.
- `deckwright replay <link | code | record.json>` prints a match's result, scores and a final-state digest. `--out` saves the record.

**Spectators**
- The relay accepts `{ t: 'watch' }`: a spectator gets the log so far, then every new entry, and can't act.
- `TCG_SPECTATORS` caps spectators (default 64; 0 turns watching off).
- `TCG_WATCH_DELAY_MS` holds entries back from spectators (default 0, or 2 minutes in ranked) against live coaching.
- A LitNode node's gateway forwards any connection for a room, so watching works for placed matches too.

**Site**
- Results have Watch replay and Share replay.
- Two-player matches have Copy watch link; `?relay=…&watch=1` opens the spectator view.
- A replay bar: play or pause, move by move or by turn (arrow keys and space), a scrubber, flip view and copy link.

## 0.4.0 (2026-10-24): the fun pass

**Rules**
- Effect library (`src/core/effects.ts`): every op is defined once (checks, targets, resolution, card text). New ops: `shield` and `summon`.
- Targets: chosen (`enemy`, `enemy-unit`, `own-unit`, `any-unit`) or automatic (`all-enemy-units`, `weakest-enemy`, `this`, and more).
- Keywords: `rush`, `lifesteal`, `shield`, `poison` and `elusive`, joining `guard` and `haste`.
- Unit abilities fire on `play` (can aim), `death` (can chain), `turnStart` and `attack`.
- Hero powers (`champion.powers`, action op 6): once per turn. Each champion's power is chosen by its card's element, its kind, or its highest stat.
- Draws mix the seed with the entropy of every accepted action up to the turn's start, so nobody can read draws ahead. Replays stay exact.

**Tools**
- `sim` prints fun targets and hero power win rates. `--strict` fails on any miss, and CI runs it.
- `import` applies a design kit: each element gets an archetype, with tiered keywords and abilities, element spells and relics, a token unit and a hero power. `--plain` skips it.
- The bot values keywords, sees lethal coming, and plays energy and draw cards.

**Games**
- `rapture-duel.v4`:
  - element hero powers (Lava Strike, Water Bolt, Earth Ward, Metal Forge);
  - life 20–26;
  - passes every fun target with suggested, random and base-stat decks.
- `starter-duel.v3` shows off the ability system, with life 18–24.

**Site:** card text comes from the effect library. Adds keyword tooltips, shields, hero power buttons with targeting, and powers in the champion picker.

## 0.3.0 (2026-10-23): trust and balance

**Champions and the relay**
- `normalizeStats` is the one way every surface turns a champion into stats. A missing champion or stat is 0, matching LitNode.
- The relay reads champion stats on chain and ignores what clients claim. In placed matches, the PlayerProfile wallet must own the champion.
- Owned-only decks (`TCG_OWNED=1`, the default for ranked): the relay rejects collection cards the wallet doesn't hold.

**Tools and rules**
- `sim --decks suggested|random|mixed` and `--stats random|base`, with per-card deck win rates.
- New optional rule `secondPlayerCards`.

**Games:** `rapture-duel.v3` (36-card decks) and `starter-duel.v2`, both with first-player wins of 45–55%.

## 0.2.0 (2026-10-23): wallet decks and the Claude Code plugin

- **Wallet decks:** `deckRules.mode: "declared"`. Decks are declared card by card in the match log. `rapture-duel.v2` has 30-card wallet decks.
- **Site:** a deck builder (suggested, wallet or manual) and a "Build your own" section.
- **Claude Code plugin:** install with `/plugin marketplace add strodanodev/deckwright`, then `/plugin install deckwright@deckwright`.
- **CI:** typecheck, tests, the engine bundle matching its source, and a create, sim and title smoke test.

## 0.1.0 (2026-10-23): first release

- One JSON file is a game. Any ERC-721 collection becomes cards, and ERC-6699 stats make champions.
- The browser, the match relay and a LitNode ruleset all run the same pure rules core, so every match replays.
- Commands: `create`, `new`, `snapshot`, `import`, `sim`, `title`, `web`, `dev`, `relay`.
