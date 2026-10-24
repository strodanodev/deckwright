# Genesys adapter (optional)

Use this to embed a Tessaract duel in a Genesys (`@gnsx/genesys.js`) scene.

## Install

1. Copy `src/core/`, `src/client/session.ts` and `src/client/shell.ts` into the Genesys project's `packs/tessaract/src/` (keep the same folders).
2. Copy `DuelHud.ts` and `TcgDuelNode.ts` from this folder into `packs/tessaract/src/client/`.
3. Add `packs/tessaract/config.json`, with `"type": "asset-pack"` and `"id": "tessaract"`.
4. Run `pnpm build`.

## Use

```ts
import { TcgDuelNode } from '@packs/tessaract/client/TcgDuelNode';
import game from './my-duel.game.json';

world.add(TcgDuelNode.create({ name: 'Duel' }).configure(game as GameConfig));
```

## How it behaves

- The node picks its session from the page URL:
  - `?match=`: a placed LitNode match;
  - `?relay=`: the dev relay;
  - otherwise: practice against the bot.
- `DuelHud` builds the board from Genesys UI-kit widgets.
- These two files import the engine, so they are not part of this repo's typecheck.
