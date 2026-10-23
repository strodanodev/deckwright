# Deckwright (contributors)

Read `plugin/skills/deckwright/SKILL.md` and its `references/`: it is the product's own guide. The parts that matter when changing Deckwright itself:
- the "Rules that keep matches replayable" section;
- the "Extending Deckwright" section.

Checks before committing:
- `pnpm typecheck` and `pnpm test`.
- `pnpm web games/rapture-duel.game.json --collection <rapture cards.json>` after any change to `src/core` or `src/client`. CI fails when `web/engine` is stale.
- `claude plugin validate .` and `claude plugin validate ./plugin` after editing the plugin.
- Champion stats go through `normalizeStats` (`src/core/champion.ts`) everywhere; a missing champion or stat is 0, as LitNode hydrates it.
- Balance changes: `pnpm sim <game> --matches 1000` with both `--decks suggested` and `--decks random` for declared-deck games; every fun target must pass (`--strict`), and bump the `rulesetId`.
- New effects and keywords live in `src/core/effects.ts` (one entry each); never special-case an op elsewhere.
- Rapture Duel v4 is the design-kit import of the Rapture snapshot plus its overrides (title, element colours, `rules.secondPlayerCards: 1`, `deckRules`, champion life 20–26).
- Bump `version` in both `package.json` and `plugin/.claude-plugin/plugin.json` (and the marketplace entry) when releasing.
