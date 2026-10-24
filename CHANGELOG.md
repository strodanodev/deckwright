# Changelog

Every rules or card change ships under a new `rulesetId`, so a game built on an older Deckwright keeps replaying exactly as it did.

## 0.8.0 (2026-10-24): the real arena

No rules change: every ruleset replays exactly as before.

**Rapture Chess's level, live.** The Valhalla and Underworld arenas are now the Blender-built models from Rapture Chess, rendered with three.js behind every screen:
- the realm's sky dome with aurora and stars, fog, and its key, rim and hemisphere lighting;
- the arena with its flowing lava shader and flickering fire;
- bloom on what is hot, and AgX tone mapping.

The camera circles the arena on the title screen and looks down over the dais in battle. The port is `src/arena3d` (stage and realm), bundled to `web/arena3d.js`.

**Loading**
- The 3D arena loads after the title screen, when the page is idle. It needs a real GPU and is skipped for software renderers and data-saver mode.
- The models were decoded from Draco and quantized (KHR_mesh_quantization), so three.js reads them with no decoder, WebAssembly or worker.
- Shaders compile in the background (`compileAsync`).
- If anything fails, or the frame rate can't hold even at reduced resolution, the client keeps the CSS arena. `#arena[data-fallback]` says why.
- The only security-policy change: `connect-src` allows `blob:`, which three.js uses to decode the models' embedded textures.

**Cost control**
- Resolution steps from 1.5× down to 0.75× if the frame rate drops.
- The arena draws at 30 fps behind the battle and nothing in a hidden tab.
- `window.deckwright.arenaStats()` reports frame rate, frame time, draw calls and triangles.

**Profiling:** `node scripts/profile-web.mjs <url> [--runs 5] [--gpu] [--detail]`. It drives headless Chrome over the DevTools protocol, with one cold load and N warm ones, and reports:
- time to the title screen, page-ready and load times;
- JS bytes;
- main-thread long tasks after the title, attributed to `arena:*` marks;
- which arena ran, and its frame stats.

**Battle layout:** the fanned hand hangs below your plate instead of covering it.

## 0.7.0 (2026-10-24): the game client

No rules change: every ruleset replays exactly as before. The web client is rebuilt as a game, in Rapture Chess's design.

**Screens**
- A boot screen and a title screen over a live arena: the gilded logo, the main menu, and a featured champion card with foil and tilt.
- Champion select: framed cards by rarity, stat meters, the hero power, the battlefield, and the bot's strength (easy, normal, hard).
- The deck forge: real card faces, your deck, a mana curve, and suggested or wallet decks.
- The Gauntlet's road, the daily puzzle and the profile as their own pages, plus "Build your own" on the demo.
- A versus loader (a two-player match waits there for the opponent), then the battle.
- Gilded iris transitions between screens.

**Battle**
- Plates for both champions (portrait, life, energy, hero power, relics), a turn medallion and narration.
- Arched unit tokens on the dais, and a fanned hand that lifts on hover.
- The end-turn medallion, turn banners, damage floaters, the fallen feed, a battle menu (Esc), and the replay and spectator dock.
- A result screen with the match in four numbers, your champion, Rematch, Watch replay and Share replay.

**The arena:** Rapture Chess's two realms, Valhalla and the Underworld, as layered CSS and SVG: sky, aurora or lava glow, skyline, a perspective floor with the octagonal dais, pillars, braziers and embers. It needs no 3D engine.

**Architecture**
- `web/app.js` is now only the wiring: data, wallet, profile and the flows between screens.
- `web/ui/`: a DOM helper, the router, the arena, the cards and one module per screen.
- `web/styles/`: theme, arena, cards, screens and battle.
- Loading: `index.html` preloads every module and the game data, so they download in parallel instead of one import level at a time (a test keeps the list equal to the files). Boot waits only for the featured champion's art, not six images. A `deckwright:title` performance mark times the title screen.
- `web/meta.js` and `web/app.css` are gone. Scaffolded games get `ui/` and `styles/`. Without the funnel marker in `index.html`, the client leaves out "Build your own" and credits Deckwright on the title screen.

## 0.6.0 (2026-10-24): the meta loop

No rules change: every ruleset replays exactly as before. Everything below runs in the browser, with no server.

- **Profile** (`src/meta/profile.ts`):
  - match history with replays, win rate, current and best streak, records per champion, Gauntlet bests, and the daily-puzzle streak;
  - kept in local storage under the game's rulesetId without its version, so a profile survives balance patches.
- **Gauntlet** (`src/meta/gauntlet.ts`):
  - eight seeded bot matches, with rising opponent stats, rarer opponent decks, and easy, then normal, then hard bots;
  - after each win you pick a reward: a card that replaces your weakest (declared-deck games), or a blessing of +12,000 to one champion stat;
  - one loss ends the run.
  - Tuned so a normal-bot player wins stages 3–7 about 50–75% of the time; the final boss is the wall.
- **Daily puzzle** (`src/meta/puzzle.ts`):
  - "win this turn" from the winner's final turn of a seeded bot match, so it's always solvable and the same for everyone on a UTC date;
  - random playouts rate its difficulty;
  - a solution is an ordinary match record.
- **Bot levels:** `greedyBot(rules, { level: 1 | 2 | 3 })`. Easy is a seeded pick among its top three moves; hard looks one action deeper. Bot opponents can be given a deck (`LocalBotSession` `foeDeck`). New `PuzzleSession`.
- **Site:** a mode bar (Practice, Gauntlet, Daily puzzle, Profile); finished matches go into the profile, with Watch buttons for their replays.

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
