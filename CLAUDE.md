# Deckwright (contributors)

Read `plugin/skills/deckwright/SKILL.md` and its `references/`: it is the product's own guide. The parts that matter when changing Deckwright itself:
- the "Rules that keep matches replayable" section;
- the "Extending Deckwright" section.

Checks before committing:
- `pnpm typecheck` and `pnpm test`.
- `pnpm web games/rapture-duel.game.json --collection <rapture cards.json>` after any change to `src/core` or `src/client`. CI fails when `web/engine` is stale.
- `claude plugin validate .` and `claude plugin validate ./plugin` after editing the plugin.
- Champion stats go through `normalizeStats` (`src/core/champion.ts`) everywhere; a missing champion or stat is 0, as LitNode hydrates it.
- Balance changes: `pnpm sim <game> --matches 1000` with both `--decks suggested` and `--decks random` for declared-deck games; keep first-player wins in 45–55%, and bump the `rulesetId`.
- Bump `version` in both `package.json` and `plugin/.claude-plugin/plugin.json` (and the marketplace entry) when releasing.
