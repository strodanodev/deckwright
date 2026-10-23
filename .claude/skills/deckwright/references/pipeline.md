# Building on LitVM Games characters

Deckwright reads any ERC-721 collection. This page covers the one it was built with: the **Rapture**
characters on LitVM Liteforge (testnet, chain id `4441`), plus the public data a builder can use.

## Public data

| What | Where |
|---|---|
| Collection (ERC-721 + ERC-6699) | `RaptureCards` `0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721` |
| On-chain metadata | `RaptureCards.tokenURI(id)` returns base64 JSON with traits (Kind, Path, Faction, Alignment, Element, Frame, Kit), the 4 stats and the image on IPFS |
| Champion stats | `RaptureCards.coreStats(id)` (ERC-6699 CoreStats: strength, agility, resilience, intelligence, level, experience) |
| Snapshot of all 50 designs | `https://forge.litvm.games/assets/rapture/cards.json`, or build your own with `deckwright snapshot 0x138F…2721 --chain liteforge` |
| Wallet holds any Rapture card? | `GET https://forge.litvm.games/api/rapture/holder?address=0x…` (CORS open) |
| 3D avatars | `animation_url` in the token JSON: meshopt GLB (`erc6699-avatar/1`) |
| Chain | RPC `https://liteforge.rpc.caldera.xyz/http`, explorer `https://liteforge.explorer.caldera.xyz` |

**Using the art, names or avatars in your own game needs permission from LitVM Games.** The data is
public, but the characters are not covered by Deckwright's code license (see `NOTICE`).

## ERC-6699 in one paragraph

ERC-6699 is the character-agent interface proposed by LitVM Games; no official EIP number is assigned. A token carries:
- **CoreStats:** four uint16 stats, plus level and experience;
- **AgentManifest:** a `character.json` URI and hash, a SOUL.md hash, a controller and nonces;
- **equipment slots.**

LitNode hydrates a player's champion from an ERC6699Registry at match placement. Deckwright maps the four stats onto bounded champion numbers (`champion` in the game config).

## Collection → playable set (Rapture)

```bash
deckwright snapshot 0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721 --chain liteforge --out collection
deckwright import collection/cards.json --id rapture-duel --out games
```

**What the importer produces**
- **Cost** comes from Kind: Mortal 1, King 2, Demigod 3, Titan 4, God 5. A collection without Kinds uses stat-power quintiles instead.
- **Attack** = round(str/65535 × (cost+3)).
- **Health** = round(res/65535 × (cost+4)).
- **Keywords:** `guard` when res ≥ 1.25 × str; `haste` when agi is the top stat.
- **Elements:** Rapture's four form a cycle (water > lava > metal > earth > water). Other collections get a cycle over their own elements.
- **Support:** the template's neutral spells and relics are appended.
- Each card keeps `token: {chainId, collection, tokenId}`.

## The wider LitVM Games stack

| Piece | What it is |
|---|---|
| Rapture Studio | Where characters are designed: card art, 3D avatar, SOUL.md, design JSON |
| PackShop | Paid card packs on Liteforge (forge.litvm.games) |
| LitNode | Decentralised match placement, witness replay and on-chain settlement for titles. Deckwright is compatible but not yet integrated (see [litnode.md](litnode.md)) |
| Deckwright | This SDK: the card game rules, relay, client and tools |
