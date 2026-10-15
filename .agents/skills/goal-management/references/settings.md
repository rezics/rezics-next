# Goal settings


`.goalctl/settings.schema.json` defines version 1 of the settings format.
Every file declares `"version": 1`. Built-in defaults are overridden field by
field by tracked `.goalctl/settings.json`, then ignored
`.goalctl/settings.user.json`. Arrays replace the earlier array. Keep accounts,
machine paths, recipients and operational choices in the user file; the shared
file carries only portable project defaults. `task goal -- config` prints the
effective settings and each field's source. Invalid layers report their file
and field. Interactive commands use the current checkout's `.goalctl/`;
launched workers and coordinator turns inherit the originating settings directory.

`accounts` is a user-layer array. Each entry has a unique `engine` name,
`launcher` (an executable name or path) or `home` (a Codex home), numeric
`weight` greater than or equal to zero, and optional `pastAllowance`, an ordered
array of resources permitted after the allowance is exhausted. Its default is
empty. `GOAL_CODEX_PAST_ALLOWANCE` passes that array as JSON to the launcher,
which implements resource-specific continuation in the configured order. A home without a
launcher uses `codex`. Supply a home for native session and usage readouts;
launcher-only accounts still appear with unavailable usage. Relative paths
resolve from `.goalctl/`; `~/` resolves from the user's home. Names cannot
shadow model selectors such as `sol` or `luna`.

For new `sol` work, selection maximizes weight times remaining allowance share
(weekly usage when available, otherwise current usage; unknown usage starts
with a full share). Ties retain configuration order, zero weights disable
automatic dispatch, and exhausted accounts require a nonempty `pastAllowance`.
A resumed attempt retains its recorded account. With no entries, the default
is the `codex` launcher. Removing the user file restores shared and built-in
defaults.

Other fields are `codexServiceTier` (`fast`, `default` or `flex`),
`reviewEngine` (a configured account, `sol` for selection, or `sonnet`),
`confirmIntervalMinutes` (zero disables scheduling), `gateLanes`, `qaSlots`,
`regressLaneCount`, `unitGateScope` (`affected` or `changed`),
`unitGateShards`, and `telegramChat`. Counts are positive integers. Existing
environment overrides continue to apply to individual commands.

The first settings load imports legacy one-value settings from
`.temp/goal-orchestration/` into missing user fields and reports each import.
Imported files gain a `.migrated` suffix so later loads cannot import them
again. The legacy names are `codex-service-tier`, `review-engine`,
`confirm-interval-minutes`, `gate-lane-count`, `qa-slot-count`,
`regress-lane-count`, `unit-gate-scope`, `unit-gate-shards`, and `telegram-chat`.
Ledger, run reports, mail, locks and last-start timestamps stay in `.temp/`.

