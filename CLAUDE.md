# Deckwright (contributors)

Read `plugin/skills/deckwright/SKILL.md` and its `references/`: it is the product's own guide. The parts that matter when changing Deckwright itself:
- the "Rules that keep matches replayable" section;
- the "Extending Deckwright" section.

Checks before committing:
- `pnpm typecheck` and `pnpm test`.
- `pnpm web games/rapture-duel.game.json --collection <rapture cards.json>` after any change to `src/core` or `src/client`. CI fails when `web/engine` is stale.
- `claude plugin validate .` and `claude plugin validate ./plugin` after editing the plugin.
- Bump `version` in both `package.json` and `plugin/.claude-plugin/plugin.json` (and the marketplace entry) when releasing.
