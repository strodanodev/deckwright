# Game config reference

The types are defined in `src/core/types.ts` and validated by `validateGame()` in `core/game.ts`, which every tool runs first.

## Top level

| Field | Type | Notes |
|---|---|---|
| `title` | string | Arcade title |
| `description` | string? | Arcade blurb |
| `litnode` | object | See below |
| `elements` | `ElementDef[]` | `{ id, name, beats?: id[], color? }` |
| `champion` | object | How ERC-6699 stats become champion numbers, and hero powers |
| `rules` | object | Board and economy numbers |
| `cards` | `CardDef[]` | The card pool |
| `deck` | `{ cardId: copies }` | The default deck (5–120 cards). With fixed decks every player plays it; with declared decks it's the suggested and fallback deck |
| `deckRules` | `{ mode, size, maxCopies }`? | How decks are chosen; omit for `fixed`. See below |
| `cardBack` | string? | Asset path for the client |

## `deckRules` (wallet decks)

| Field | Values | Notes |
|---|---|---|
| `mode` | `"fixed"` (default) or `"declared"` | `declared`: each player brings their own deck, for example the cards their wallet holds |
| `size` | 5–60 | Cards per declared deck. The default `deck` must hold at least this many |
| `maxCopies` | 1–10 | Copies of one card allowed |

**How declared decks work**
1. The match opens in a **deck phase**: each player sends one `declare(cardIndex)` per card, and both sides may declare in the same log entry.
2. Once both decks are full, each is shuffled from the match seed (`<seed>|deck|<side>`), opening hands are drawn, and turn 1 starts.
3. Everything is in the input log, so a LitNode node replays it with no extra data.

**Who may play which card**
- **Ownership is not a rule:** LitNode's replay can't read the chain, so the match server enforces it. Casual play accepts any card.
- **Owned-only matches** (`TCG_OWNED=1` on the relay; the default for ranked): before the match starts, the relay reads which collection cards the player's wallet holds. It then rejects any declared collection card the wallet lacks. Support cards (no `token`) are always allowed. In a placed match the wallet is the one LitNode's PlayerProfile binds to the player key, so nobody signs anything extra.
- **Deadline:** a player who hasn't finished declaring gets the rest of the suggested deck, from cards they may declare. A player who can't complete a legal deck concedes.
- **Local test:** run the dev relay with `TCG_OWNED=1`, open the site with `&owned=1` and connect a wallet. A dev relay trusts the wallet the page names.

**Helpers**
- `rules.suggestedDeclaration(state, side)` fills a deck from the suggestion. Bots use it, and so does the relay when a player hasn't declared by its deadline (`TCG_DECK_MS`, default 90 s).

Balance tip: smaller decks raise the first-player advantage, and random wallet decks can favour the first player more than the suggested deck does. Check both with `deckwright sim --decks suggested` and `--decks random`. Rapture Duel uses 36 cards with `secondPlayerEnergy: 1` and `secondPlayerCards: 2`, which gives about 52–53% first-player wins either way.

## `litnode`

| Field | Range | Notes |
|---|---|---|
| `rulesetId` | `name.vN` | A new N for any rules or card change |
| `tickRate` | 1–120 | Nominal; turn games log one entry per action |
| `maxTicks` | 20–5000 | Log cap; at the cap the higher life wins. The bot averages about 40 entries a match |
| `modes` | `["ranked","casual"]` subset | Ranked needs at least 3 bonded witnesses on the mesh |
| `eloK` | 1–64 | Elo ladder derived from settled results |
| `url`, `cover`, `accent` | string? | Arcade listing |

## `champion`

Each entry is `{ stat, min, max }`.
- `stat` is one of `strength`, `agility`, `resilience` or `intelligence`, each a uint16 from 0 to 65535.
- The value is mapped linearly onto the integer range `[min, max]`.

Keep the ranges narrow: the spread is how much NFT stats matter.

A player with no champion, and any stat a champion lacks, counts as 0, so they get each range's `min`. That is what LitNode hydrates for a player without a registry champion, and practice, the relay, the sim and the ruleset all use the same `normalizeStats`.

| Key | Effect |
|---|---|
| `life` | Starting and maximum life |
| `spellPower` | Added to damage spells and relics |
| `unitAttack` | Added to the attack of every unit you play |
| `openingHand` | Cards drawn before turn 1 |
| `powers` | Optional hero powers (below) |

### Hero powers (`champion.powers`)

```json
"powers": [
  { "id": "lava-power", "name": "Lava Strike", "cost": 2, "element": "lava", "effect": { "op": "damage", "amount": 2, "target": "enemy-champion" } },
  { "id": "rally", "name": "Rally", "cost": 2, "effect": { "op": "buff", "attack": 1, "health": 1 } }
]
```

- Once per turn, for `cost` energy (0–10), a player may use their champion's power. Its effect works like a spell's, without spellPower.
- Each champion gets the **first** power whose conditions all match:
  - `element` / `kind`: the champion card's element or kind (the card whose `token.tokenId` is the champion's token);
  - `stat`: the champion's highest ERC-6699 stat.
- An entry with no conditions is the default; players without a champion only match that one.
- Power by element keeps NFT rarity out of it (powers are sidegrades). Rapture Duel uses element powers.

## `rules`

| Field | Notes |
|---|---|
| `boardSlots` | 1–5 units per side; the action encoding addresses 5 own units |
| `relicSlots` | 0–5 |
| `handLimit` | 1–16; when the hand is full, a drawn card is burned |
| `energyStart`, `energyMax`, `energyPerTurn` | Energy cap grows each turn and refills |
| `secondPlayerEnergy` | Bonus energy on the second player's first turn. A coarse lever: each point moves first-player wins by about 10–20 points |
| `secondPlayerCards` | Optional, 0–5 (default 0). Extra cards in the second player's opening hand. A finer lever: each card moves first-player wins by about 3–8 points |
| `elementBonus` | Extra damage when the attacker's element `beats` the defender's (unit vs unit, and damage spells vs units) |
| `fatigue` | Drawing from an empty deck deals 1, then 2, then 3… |

## Cards

```json
{ "id": "ember-vanguard", "name": "Ember Vanguard", "type": "unit", "element": "fire", "cost": 4,
  "attack": 5, "health": 4, "keywords": ["guard"], "rarity": "rare",
  "art": "ipfs://…", "token": { "chainId": 4441, "collection": "0x…", "tokenId": "…" } }
```

**Common fields**
- `id`: kebab-case.
- `type`: `unit`, `spell` or `relic`.
- `cost`: 0–99.
- `rarity`: `common`, `uncommon`, `rare`, `epic` or `legendary` (used for the ItemCard badge).
- `art` and `token`: display only in v1.

**Units**
- `attack`: 0–99. `health`: 1–99.
- Units can attack from their owner's next turn. Attacking deals simultaneous damage. A unit with element `beats` the defender's deals `elementBonus` extra.
- `keywords` (any of):

| Keyword | Effect |
|---|---|
| `guard` | Enemies must attack guards first (spells ignore guard) |
| `haste` | Can attack the turn it is played |
| `rush` | Can attack units, not the champion, the turn it is played |
| `lifesteal` | Damage it deals heals its champion (up to starting life) |
| `shield` | The first damage it would take is blocked |
| `poison` | Any damage it deals to a unit destroys that unit |
| `elusive` | Enemy spells, powers and abilities can't choose it (area effects still hit) |

- `abilities` (up to 3): `{ "on": trigger, "effect": effect }`.

| `on` | Fires | Targets |
|---|---|---|
| `play` | When you play it | May take a chosen target (the play action's target). With no legal target it fizzles and the unit is still played |
| `death` | When it dies (chains up to 16 rounds per action) | Automatic only; `this` doesn't work |
| `turnStart` | At each of its owner's turn starts, after relics | Automatic only |
| `attack` | When it attacks, before the hit | Automatic only |

**Spells** resolve once. **Relics** fire their effect at each of their owner's turn starts (automatic targets only).

### Effects

Every op is defined once in `src/core/effects.ts`, so rules, bot, sim and card text all agree.

| `effect` | Does | Default target (chosen / automatic) |
|---|---|---|
| `{ "op": "damage", "amount": n }` | Deal n (spells add spellPower). Units take +elementBonus from cards whose element beats theirs | `enemy` / `enemy-champion` |
| `{ "op": "heal", "amount": n }` | Restore life (up to starting life) or unit health (up to its max) | `self` |
| `{ "op": "draw", "amount": n }` | Draw n | — |
| `{ "op": "energy", "amount": n }` | Gain n energy this turn | — |
| `{ "op": "buff", "attack": a, "health": h }` | +a/+h (raises max health too) | `own-unit` / `newest-own-unit` |
| `{ "op": "shield" }` | Give a shield | `own-unit` / `newest-own-unit` |
| `{ "op": "summon", "card": id, "count": n }` | Put n copies of a unit card on your board (no play ability) | — |

Add `"target"` to choose who it hits:
- **Chosen** (spells, hero powers, `play` abilities): `enemy` (champion or unit), `enemy-unit`, `own-unit`, `any-unit`.
- **Automatic** (anywhere): `self`, `enemy-champion`, `all-enemy-units`, `all-own-units`, `all-units`, `weakest-enemy` (least health, leftmost; else the champion), `newest-own-unit`, `this` (the ability's own unit).

The validator rejects a chosen target where no choice is possible, an op/target pair that makes no sense, and a summon of anything but a unit card.

## Actions (`core/actions.ts`)

`x = op | a << 3 | target << 7`

| Part | Values |
|---|---|
| `op` | 1 play, 2 attack, 3 end turn, 4 concede, 5 declare (deck phase; bits 3–17 are the card index), 6 hero power |
| `a` | Hand index (play) or board slot (attack) |
| `target` | 0 enemy champion; 1–9 enemy unit at slot+1; 10 own champion; 11–15 own unit at slot+11. Effects that need no choice use 0 |

Helpers:
- `play(handIndex, target)`, `attack(slot, target)`, `power(target)`, `endTurn()`, `concede()`
- `enemyUnit(slot)`, `ownUnit(slot)`
- `rules.legalActions(state)` lists every legal action; `rules.isLegal(state, x)` checks one.

Concede is honoured on either player's frame. The gauntlet injects it for a player who stays disconnected, and injects END for a player whose turn clock runs out.

## State

- `MatchState` is what `serialize()` returns: everything. LitNode hashes it into the state root.
- **Draws** take a random card of the deck, from the seed, the entropy of every accepted action up to the turn's start (`turnEnt`), and a draw counter. Nobody can compute a draw before the opponent has finished the turn before it, yet every replay draws the same cards.
- `view()` replaces each deck with a count.
- `winner` is −1 while the match is live, 0 or 1 for the winning side, and 2 for a draw.
- `scores()` gives `{ winner: 1, loser: 0 }`; a draw gives 0 to both.
