# Game config reference

The types are defined in `src/core/types.ts` and validated by `validateGame()` in `core/game.ts`, which every tool runs first.

## Top level

| Field | Type | Notes |
|---|---|---|
| `title` | string | Arcade title |
| `description` | string? | Arcade blurb |
| `litnode` | object | See below |
| `elements` | `ElementDef[]` | `{ id, name, beats?: id[], color? }` |
| `champion` | object | How ERC-6699 stats become champion numbers |
| `rules` | object | Board and economy numbers |
| `cards` | `CardDef[]` | The card pool |
| `deck` | `{ cardId: copies }` | Every player plays this deck (5–120 cards). Shuffled per player from the match seed |
| `cardBack` | string? | Asset path for the client |

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

| Key | Effect |
|---|---|
| `life` | Starting and maximum life |
| `spellPower` | Added to damage spells and relics |
| `unitAttack` | Added to the attack of every unit you play |
| `openingHand` | Cards drawn before turn 1 |

## `rules`

| Field | Notes |
|---|---|
| `boardSlots` | 1–5 units per side; the action encoding addresses 5 own units |
| `relicSlots` | 0–5 |
| `handLimit` | 1–16; when the hand is full, a drawn card is burned |
| `energyStart`, `energyMax`, `energyPerTurn` | Energy cap grows each turn and refills |
| `secondPlayerEnergy` | Bonus energy on the second player's first turn |
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
- Keywords:
  - `guard`: enemies must attack guards first; spells ignore guard.
  - `haste`: can attack on the turn it is played.
- Units play with `ready = haste` and become ready at their owner's turn start. Attacking deals simultaneous damage.

**Spells** resolve once. **Relics** fire their effect at each of their owner's turn starts. Effects:

| `effect` | Spell target | Relic target |
|---|---|---|
| `{ "op": "damage", "amount": n }` | Enemy champion or enemy unit (+spellPower, +elementBonus vs a unit) | Enemy champion |
| `{ "op": "heal", "amount": n }` | Own champion (capped at starting life) | Own champion |
| `{ "op": "draw", "amount": n }` | — | — |
| `{ "op": "energy", "amount": n }` | Gain energy now | Gain energy at turn start |
| `{ "op": "buff", "attack": a, "health": h }` | One of your units | Your newest unit |

## Actions (`core/actions.ts`)

`x = op | a << 3 | target << 7`

| Part | Values |
|---|---|
| `op` | 1 play, 2 attack, 3 end turn, 4 concede |
| `a` | Hand index (play) or board slot (attack) |
| `target` | 0 enemy champion; 1–9 enemy unit at slot+1; 10 own champion; 11–15 own unit at slot+11 |

Helpers:
- `play(handIndex, target)`, `attack(slot, target)`, `endTurn()`, `concede()`
- `enemyUnit(slot)`, `ownUnit(slot)`
- `rules.legalActions(state)` lists every legal action; `rules.isLegal(state, x)` checks one.

Concede is honoured on either player's frame. The gauntlet injects it for a player who stays disconnected, and injects END for a player whose turn clock runs out.

## State

- `MatchState` is what `serialize()` returns: everything, including deck order. LitNode hashes it into the state root.
- `view()` replaces each deck with a count.
- `winner` is −1 while the match is live, 0 or 1 for the winning side, and 2 for a draw.
- `scores()` gives `{ winner: 1, loser: 0 }`; a draw gives 0 to both.
