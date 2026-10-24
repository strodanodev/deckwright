# Card design guide

Numbers that produce a playable, balanced Tessaract set on the first pass. They're calibrated against the
default rules:
- energy starts at 1, grows by 1 per turn and caps at 10;
- the second player gets +1 energy on their first turn, and +1 card in their opening hand (`secondPlayerCards`);
- the board holds 5 units and the hand holds 8.

Run `tessaract sim` and adjust from there.

## Set shape (18–24 distinct cards)

| Type | Share of the deck | Notes |
|---|---|---|
| Units | 60–70% | Most of the curve; at least 2 guard units and 2 haste units |
| Spells | 20–30% | Mix damage (removal), one heal, one draw, one buff |
| Relics | 5–10% | 1–3 total; they fire every turn, so keep them cheap in effect |

**Cost curve** for a 25–30 card deck, as the share of cards at each cost:

| Cost | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|
| Share | 20% | 25% | 20% | 15% | 12% | 8% |

## Unit stat budget

A unit's **attack + health ≈ 2 × cost + 1**:

| Cost | Budget | Typical statlines |
|---|---|---|
| 1 | 3 | 2/1, 1/2 |
| 2 | 5 | 3/2, 2/3, 1/4 |
| 3 | 7 | 3/4, 4/3, 2/5 |
| 4 | 9 | 5/4, 4/5, 3/6 |
| 5 | 11 | 5/6, 4/7, 6/5 |
| 6 | 13 | 6/7, 7/6 |

Keyword and ability prices, paid from the budget:

| Kit | Price | Notes |
|---|---|---|
| `guard` | 0–1 | Put it on high-health bodies |
| `haste` | 1 | Hits the turn it lands; the main tool for closing games |
| `rush` | 1 | Trades the turn it lands; safer than haste |
| `shield` | 1–2 | Worth about one extra hit; best on high attack |
| `lifesteal` | 1 | Scales with attack |
| `poison` | 1–2 | Turns a cheap body into removal; keep attack low (1–2) |
| `elusive` | 1 | Strong with buffs |
| `play`: deal 2 (chosen) | 2 | A spell stapled to a body |
| `play`: deal 1 to all enemy units | 2 | Board control; 2 to all is a cost-5 effect |
| `death`: summon a 1/1 | 1 | Two at cost 5 |
| `turnStart`: +0/+1 to itself | 1 | Grows into a wall |
| `attack`: deal 1 to the enemy champion | 1 | Rewards attacking |

`tessaract import` applies a kit like this automatically (src/tools/design-kit.ts); its tiers are a good reference.

**Hero powers** cost 1–3. Aim for each power to win 45–55% against the others (`sim` prints the rates). Rapture TCG's four:
- Lava Strike (2): 2 to the enemy champion.
- Water Bolt (3): deal 1, chosen.
- Earth Ward (2): shield a friendly unit.
- Metal Forge (1): summon a 1/1.

Pure healing powers stall games and cut close finishes; prefer shields and buffs.

Champions add `unitAttack` (0–1 by default) to every unit, so keep base attack modest.

## Spell and relic values (amount by cost)

| Effect | Cost 1 | Cost 2 | Cost 3 | Cost 4+ | Notes |
|---|---|---|---|---|---|
| `damage` | 2 | 3 | 4 | 5–6 | +spellPower, and +elementBonus against units it beats |
| `heal` | 3 | 5 | 7 | — | Caps at starting life |
| `draw` | 1 | 2 | — | — | Card advantage is strong; keep it cheap and small |
| `energy` | 2 (net +1) | — | — | — | Ramp; one copy at most |
| `buff` | +1/+1 | +2/+1 | +2/+2 | — | Needs a unit on the board |

**Relics** fire at the start of their owner's every turn, so total impact over about 6 turns ≈ amount × 6:
- `damage` relic: amount 1, cost 2–3.
- `heal` relic: amount 2, cost 2.
- `energy` relic: amount 1, cost 3.
- `buff` relic: +1/0 to the newest unit, cost 2.

## Elements

- Use 3–5 elements, plus an optional `neutral`. Give each a `color` and a theme identity: aggressive, defensive, value, control.
- **Cycle them** so every element beats exactly one other (`beats: ["next"]`). Neutral beats nothing and loses to nothing.
- Give each element a few units across the curve and one or two spells, so any element can win.

## Deck (`deck`)

- 25–30 cards in total.
- Usually 2 copies of commons and 1 of rares, epics and legendaries.
- `rarity` is display only (`common`, `uncommon`, `rare`, `epic`, `legendary`). Use it to signal strength, and keep legendaries memorable rather than strictly better.

## Champion mapping (`champion`)

Keep the defaults unless the theme needs otherwise. Narrow ranges make NFT stats matter a little; wide ranges make them matter a lot.
- life 18–24 (lower life means shorter, closer matches; 20–26 for sets with lots of healing)
- spellPower 0–2
- unitAttack 0–1
- openingHand 3–5

## Naming

- Names fit the theme and stay at most 24 characters; they render small on cards.
- Ids are kebab-case versions of the names, for example `"Tide Warden"` becomes `tide-warden`.
