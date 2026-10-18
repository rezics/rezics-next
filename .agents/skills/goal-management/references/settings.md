# Goal settings


The [settings schema](../../../../.goalctl/settings.schema.json) defines the
format and field constraints. Each file declares `"version": 1`. Built-in
defaults are overridden field by field by tracked `.goalctl/settings.json`
from the executing worktree, then ignored `.goalctl/settings.user.json`.
An object or array replaces the earlier field as a whole.

Keep accounts, machine paths, recipients and operational choices in the user
file; the tracked file carries portable project defaults. The machine directory
defaults to the common checkout's `.goalctl/`. `GOAL_SETTINGS_DIRECTORY` selects
that directory for workers and coordinator turns; it does not replace the
executing worktree's tracked settings. `task goal -- config` prints the effective
settings and each field's source.

Invalid known fields report their file and field. Unknown tracked fields are
rejected. Unknown user fields are reported and ignored, and migration preserves
them for newer tooling. The [loader](../../../../scripts/goal/config.ts) owns
layer selection, validation and migration.

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

Set worker compaction limits with `codexCompactTokens.sol` and
`codexCompactTokens.luna`. Each launch reads its model family's limit from the
layers above; a positive integer `GOAL_CODEX_COMPACT_TOKENS` overrides it for
that command. The [project settings](../../../../.goalctl/settings.json) hold
the portable limits. [Launch code](../../../../scripts/goal/launch.ts) owns the
context window and launch arguments.

`reviewEngine` selects a configured Codex account, `sol` for automatic account
selection, or `sonnet`. `GOAL_REVIEW_ENGINE` overrides it for one command.
`reviewEffort` defaults to `high` for Codex; Sonnet retains its CLI default
unless a settings layer supplies an effort. Supported values are in the schema,
and the selected reviewer must support the chosen effort. Invalid accounts or efforts
fail before any reviewer launches; retries keep the same effort.

`reviewFallbackEngines` defaults to `null`: a refused Codex review tries its
selected account twice, then each other configured account in configuration
order. An array replaces that fallback order and may contain only configured
Codex account names. Set it to `[]` for two tries on the selected account and
no account switch. Sonnet runs once without account fallback. Codex review
launches disable each MCP server from the attempted account's configuration;
an empty table would leave inherited servers configured.

`reviewScope` defaults to `sensitive`, retaining review of implementation and
mechanism changes in sensitive owners. Set it to `all` to review every changed
file for every brief kind, including tooling, tests and configuration, for
correctness defects. Findings without runnable public HTTP API proof remain
recorded observations for the manager under the existing landing procedure.
For a review policy pinned to `codex-1` at `xhigh`, use these user-layer fields
alongside the existing `version` and `accounts`:

```json
{
  "reviewEngine": "codex-1",
  "reviewEffort": "xhigh",
  "reviewFallbackEngines": [],
  "reviewScope": "all"
}
```

Worker engine and effort still come from each brief; select `codex-2` and
`max` there for implementation work with that account and effort.

Other settings and their allowed values are defined by the schema. Existing
environment overrides still apply to individual commands. A zero
`confirmIntervalMinutes` disables scheduled confirmation.

The first settings load imports legacy one-value settings from
`.temp/goal-orchestration/` into missing user fields and reports each import.
Imported files gain a `.migrated` suffix so later loads cannot import them
again. The legacy names are `codex-service-tier`, `review-engine`,
`confirm-interval-minutes`, `gate-lane-count`, `qa-slot-count`,
`regress-lane-count`, `unit-gate-scope`, `unit-gate-shards`, and `telegram-chat`.
Ledger, run reports, mail, locks and last-start timestamps stay in `.temp/`.

