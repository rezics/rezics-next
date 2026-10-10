# State

Checkpoint 2026-10-11 ~01:00 UTC (Asia/Taipei 09:00). Manager `kernel-sonnet` (Claude; tmux `goal-kernel`), which took over from the Sol manager on 2026-10-08 when both Codex accounts ran out. The Goal is active; C4-C6 and the completion criteria are not proven. The landed pieces below are component proofs, not whole contracts.

## Routing

Workers are Cursor only, at most 4 live. Cursor sessions drop their connection often (an empty `attempt-N.json`, "Connection stalled repeatedly"): commit after every step, run long commands in the background with a log, resume with `--fresh` and a note naming the state. No Claude, Grok, Sol or Luna workers; no top-ups. Land reviews run on Sonnet. The unit gate decides; `--skip-unit-gate` is never used, and a refusal goes to Program with the evidence.

## Landing recipe

`task gen` in the worktree and commit generated and pin files. Native work needs the pinned image built locally first (`rezics/fuseki:6.2.0-cmd0.5.39-<hash>`; the Maven suite runs inside `docker build -f infra/jena/Dockerfile`, about 20-30 minutes) and then one `task dev:refresh -- --wait`, which Program runs. Rebasing a native branch conflicts on `docs/development/toolchain.md`, `infra/dev/compose.yaml` and `scripts/dev/release-manifest.ts`: take main's, then `task gen`. A guard baseline that a registration move trips (anti-silo) is edited by hand for the moved key only; its own rewrite changes unrelated entries. Helper scripts live in `.temp/kernel/` (`merge-unit.sh`, `chain-test-merge.sh`, `after-then-chain.sh`, `build-image-1546.sh` with `WT`).

## Landed since 2026-10-09

- Search: pre-pin Content receipts (G-1584), interrupted rebuild states (G-1600, G-1613, G-1617), quarantine continuation with a legacy prior receipt (direct fix on main), native command deadline 60 s. The shared stack's public search answers again after a clean 132 s rebuild (2026-10-10 16:45 UTC).
- Claim fold deleted (G-1573); the Claims-into-Statements unification is decided and waits on provider identity.
- Structure profile document is the allowlist (G-1592, pin `ce9c77bee5cd`): a new composition kind registers as data; the section-list proof is `tests/qa/integration/structure-profile-section-list.test.ts`.
- No command seals an idempotency key on a current-visibility outcome (G-1623): the audit table and a source-scan guard are in `services/main/tests/seal-on-visibility.test.ts`. Reference shape: visibility checked before the write answers 404 with nothing written; a target lost inside the write answers 503 unsealed. `TargetUnavailable` stays the hidden==absent 404.
- Erasure of every revision kind, rights T1, conversions, discovery and meter work (see the git history).

## Next, in order

1. G-1593 provider identity (running), then G-1618 Claims are Statements (no compatibility layer; `/v1/claims` routes retired; assessment export gets the Statement shape).
2. Field-disposition projector from `source.field_disposition`, targeting Statements (brief written after G-1618 settles).
3. G-1603 year template `concept` parameter (native, depends on G-1593), G-1591 explicit public read `mode`, G-1582 discovery never-produced reads, G-1615 maintainer move (waits for Launch's realm-management change).
4. One `task dev:refresh -- --wait` for pin `ce9c77bee5cd` (asked of Program).

## Open

- Rights T2, T3a, T3b, T4, T5: send each diff to Trust-ops before landing. The Statement create has no licence field (`importBangumiWorkFacts` gap), flagged for T4.
- Abstraction A1b and A1c; ranking projection event poisoning (brief separately); a feed refresh worker answers "failed" instead of "deferred" while public search is unavailable (fold into the next feed change).
- Episode-number seek on work-composition: `traversal.ts` refuses numeric queries on work-composition manifests because no production reader exists.
- Whole-Goal remainder: 18-family and current-model convergence, external search copies and physical population locality, Discover remeasurement, exact populated restore/erasure/startup, reciprocal source promotion.

## Boundaries

- Trust-ops owns Comment/Verification C6 erasure and the hidden==absent inventory; never edit `erasure`, `content.ts` or the barriers concurrently with it.
- Launch owns the realm-reply files (G-1597) and the original fixture wiring; its assertions stay.
- Program owns wider owner regressions and gate diagnostics; Kernel fixes only failures it identifies as its own.
- The vault is manager-only; never switch HEAD in the main checkout; commit explicit paths only; no task IDs in code or comments.
