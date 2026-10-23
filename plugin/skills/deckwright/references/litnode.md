# LitNode integration

**Status: deferred.** The SDK runs without LitNode (bot and dev relay); this page is for when it is integrated.

Before integration, also change these on the **production web**:
- `vercel.json` sets `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The arcade launches titles in an iframe, so allow the cabinet origin.
- `connect-src` must include the node relay `wss://` host.

Verified against LitNode **v0.11.26** (protocol 3), which ships inside the LITNODE Control Plane as `resources/bundle/arcade-litnode.zip`. The parts that matter:
- `sdk/conformance.mjs`
- `node/gauntlet.js`, `node/settle.js`, `node/sandbox-child.mjs`
- `protocol/log.js`
- `cabinet/app.js`
- `contracts/deployed.testnet.json`

## What LitNode does and what the SDK does

| Step | LitNode | Deckwright |
|---|---|---|
| Queue and pair | The cabinet signs `queue` and POSTs `/queue`. Players pair in 2 s buckets, two at a time, by ruleset and mode | — |
| Seed | `h('seed', beacon, matchId)` from the litVM blockhash beacon | `rules.init(seed, …)` shuffles with `seededRandom` |
| Placement | A seeded host plus a 3-witness panel (stake-weighted, distinct operators). The host `commit`s on MatchBook (ranked) | — |
| Transport | The node gateway proxies `wss://<wsAddr>/LIT-<room>` to a **gauntlet** process | `src/tools/relay.ts` (one process per match) |
| Seat | `GET <wsAddr>/<room>/ticket?player=` → nonce → the cabinet signs `seat` → HMAC ticket | `RelaySession.placed()` claims the seat, then sends `hello{ticket}` |
| Log | `{k, inputs:[side0, side1]}`, hash-chained from `'genesis'` | The server sequences one entry per accepted action |
| Sign | Each player signs `{matchId, ticks, head, buildHash}` under `'ledger'` in the cabinet | The client posts `cabinet:sign` with its own `entries`; the shell recomputes the head |
| Settle | `POST /ledger`, then replay in the sandbox, then `resultHash`, then `MatchBook.settle`. Witnesses replay and co-sign or dispute. Escalation goes to a larger panel, with slashing | The gauntlet posts `{matchId, rulesetId, buildHash, mode, participants, entries, signatures, hydration}` |
| Ladder | Elo, stats and progression are folds over `Settled`/`Finalized` logs | `services.leaderboard = elo(eloK)` in the manifest |

A result is *official* only with both players' signatures plus at least one co-signing witness. A single signature, for example when one player disconnected, settles as unofficial.

## Publish a title

1. `build-title.ts … --litnode <dir>` must print `conformant`. Keep `rulesets/<id>.js` and `.json` together.
2. Register the build on chain (Liteforge 4441):
   - `TitleRegistry` `0x4A0de8EB216CC4445A767ed25c4f154d0f904489`
   - Call `register(string rulesetId, bytes32 buildHash)` from the publisher wallet. The title NFT id is `keccak256(rulesetId)`.
   - Retunes use `setBuild(titleId, newHash, activatesAt)`.
   - Without registration, nodes load the build only under `TITLE_TRUST=open` or a `TRUSTED_PUBLISHERS` signature.
   - No CLI for this ships in v0.11.26; send the calldata from a wallet.
3. Host it on a node (set these as user environment variables, then restart the Control Plane, which rewrites `node.env`):
   - `RULESETS=<abs path>/rulesets/<id>.js`
   - `GAUNTLETS=<id>=<abs path>/gauntlet.json` (copy `templates/gauntlet.json`; set `cwd` and `TCG_GAME`)
   - `GAUNTLET_GATEWAY_PORT=8478`. A node already running a relay keeps `RELAY_PORT` behind it as upstream.
   - The node must have a public `https://` address (see LITNODE/STANDBY-HOST.md §1).
4. Arcade listing: `cabinet/config.js` `GAMES` is a hard-coded roster. Adding a title is a LitNode release, so ask the LitNode maintainers. Until then, launch with the cabinet's direct URL or your own lobby.

## Champions (ERC-6699)

- The queue carries one `tokenId` per player. The gauntlet passes each player's claim in `hydration.agents[p].tokenId`.
- The node reads `coreStats` and `manifestOf` from `ERC6699Registry` at the placement's `beaconBlock`, and checks `mayPlay`: the player's PlayerProfile owner owns or controls the token.
- Ranked play is "sterile": equipment is stripped.
- **Registry mismatch (blocking for Rapture cards in ranked):**
  - LitNode v0.11.26 reads `0x38DF2543e039E775D3f674f7414df43e4eF2f883`.
  - `RaptureCards` mirrors into `0xBeEe6cFAD12346124eb3d51b716fce00B7f11949`.
  - The registry twin id is `keccak(RaptureCards, tokenId)`, not the card's tokenId.
  - Until one side moves, a node needs `ERC6699=0xBeEe…` and the client must queue with the twin id.

## Gaps and risks (v1)

- **No hidden information.** A real hand needs commit-reveal:
  1. Each player commits `H(deckOrder, salt)` across a few opening entries.
  2. Draws reveal indexes.
  3. Timeouts concede.

  It fits the integer-frame log, but it is a rules-engine change and a v2 ruleset.
- **Two players only.** Pairing, replay and intake are all hard-wired to 2.
- **Beacon.** The seed comes from a blockhash the sequencer can grind. It is fine for casual play. For stakes, add drand (as PackShopV2 does) or commit-reveal.
- **Cost.** Each match needs a 2 s bucket, a beacon block and a commit before play, about 445k gas for the host and about 75k per witness. Ranked needs at least 3 bonded witnesses, or matches are casual-only.
- **The deck is the config's deck**, not the player's wallet. A deck of owned card NFTs needs either a deck registry that the node hydrates (a LitNode change), or casual-only fixture claims.
- **The champion claim is unverified client-side.** Both clients render with the stats sent in `hello`. If a player lies, only that player's view diverges; the node's replay with registry stats decides the result.
