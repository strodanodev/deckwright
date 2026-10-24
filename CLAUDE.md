# Tessaract (contributors)

Read `plugin/skills/tessaract/SKILL.md` and its `references/`: it is the product's own guide. The parts that matter when changing Tessaract itself:
- the "Rules that keep matches replayable" section;
- the "Extending Tessaract" section.

Checks before committing:
- `pnpm typecheck` and `pnpm test`.
- `pnpm web templates/starter.game.json` after any change to `src/core` or `src/client`. CI fails when `web/engine` is stale.
- This package lives in the theforge monorepo at `packages/tessaract` and is published to github.com/strodanodev/tessaract. Games built on it (Rapture TCG, Rapture Chess) are separate products there and depend on the published SDK.
- `claude plugin validate .` and `claude plugin validate ./plugin` after editing the plugin.
- Champion stats go through `normalizeStats` (`src/core/champion.ts`) everywhere; a missing champion or stat is 0, as LitNode hydrates it.
- Balance changes: `pnpm sim <game> --matches 1000` with both `--decks suggested` and `--decks random` for declared-deck games; every fun target must pass (`--strict`), and bump the `rulesetId`.
- New effects and keywords live in `src/core/effects.ts` (one entry each); never special-case an op elsewhere.
- The meta loop (`src/meta`: profile, Gauntlet, daily puzzle) never changes rules. Rewards are champion stats and declared decks, so every match replays under the game's `rulesetId`.
- If you change Gauntlet tuning, re-check the stage-by-stage win rates with a normal-bot player before shipping.
- Add the release to `CHANGELOG.md`.
- Bump `version` in both `package.json` and `plugin/.claude-plugin/plugin.json` (and the marketplace entry) when releasing.
