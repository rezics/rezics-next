# State

Checkpoint 2026-10-10 17:10 UTC, paused for the Cursor quota (Program's rule: no dispatch, no resume, Codex wrap-up allowance is Program's). Manager `kernel-sonnet` (Claude; tmux `goal-kernel`), which took over from the Sol manager on 2026-10-08 when both Codex accounts ran out. The Goal is active; C4-C6 and the completion criteria are not proven. The landed pieces below are component proofs, not whole contracts.

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

## Wave 1 (2026-10-11, analysis first)

Live: G-1630 (Luna max, scan test and derived assembler set), G-1631 (Luna max, three 503-for-409), G-1632 (Sol, read-only: search cluster and idle timeouts), G-1637 (Sol, read-only: recipe refusal after earlier tests). Queued Sol read-only: G-1642 (local-consistency inventory with the size of converging before opening), G-1643 (provider identity in slices; G-1593 stays as input until it lands), G-1639 (graph, claim, model cluster), G-1640 (structure, discovery cluster), G-1641 (owner, relay, outbox cluster). Queued Luna: G-1638 (native tests to the image tier), G-1636 (migrate raw-update callers, after G-1630 and a Sol class table). Closed: G-1617, G-1330, G-1345 verified; G-1282, G-1300, G-1352, G-1379 cancelled; G-1397 and G-1290 were already verified. Width: 2 Sol and 3 Luna live. Three attempts, then stop and mail Program.

## Paused tasks

No kernel worktree is dirty and no task is half-done. Next step for each, when quota returns:

| Task | What exists | What is missing | Next step |
| --- | --- | --- | --- |
| G-1630 raw-update callers classified by source, not shard luck | brief; research first (classification scan, categories, one supported way) | scan test, category table, migrations | dispatch with G-1631 and G-1593 together (different files); step A lands alone first |
| G-1631 three 503-for-409 races, three hung native tests | brief | find the commits, fix or re-contract, route native tests to their tier | together with G-1630 and G-1593; prefer moving the native tests to the image tier over a skip |
| G-1632 search cluster triage and idle search budget | brief; evidence includes Program's four idle timeouts (hour 00, 02, 06:49:13, 06:51:16 UTC) | triage of SEARCH01-20 red IDs; the native phase behind the idle timeouts | with the first wave (A: red IDs) |
| G-1593 provider identity | brief only; attempt 1 exited at the quota error with a clean worktree | all of it: observation-plus-allowlist lookup in `source/*`, tests, proof | `resume G-1593 --fresh`; native-free, expect one image-free landing |
| G-1618 Claims are Statements | brief; depends on G-1593 | all of it | dispatch after G-1593 lands; no compatibility layer, `/v1/claims` retired |
| field-disposition projector | decision only (targets Statements, from `source.field_disposition`) | the brief | write after G-1618 settles |
| G-1603 year template `concept` | brief; native; depends on G-1593 | all; needs a pinned image build | after G-1593 |
| G-1591 explicit public `mode` | brief (claims `query/**`) | all | after G-1618 (same files) |
| G-1629 seal guard follows helpers | brief (Program's finding: the scan misses a seal reached through a same-file helper) | the stronger scan, failing fixtures, the list of newly surfaced seals | after G-1593; queue only while paused |
| G-1582 discovery never-produced reads | brief; depends on landed G-1579 | all | any time |
| G-1615 maintainer move | brief | waits for Launch's change to `realm-management.ts` | after it lands |
| G-1300 | old exited task; needs the original G847 integration | Launch wires production Statement seek | close when that lands |

Landed directly on main from regression run 9 (no worker needed): the recipe reader no longer takes a qualifier node as a target (the recipes went 503 after the structure-profile change), and hidden/absent targets answer 404 again with their keys still unsealed (G-1623's 503s). No task is one step from landing. Merged and closed this session: G-1592, G-1617, G-1623. The shared stack runs pin `ce9c77bee5cd` (refreshed 2026-10-10 17:01 UTC; the rebuilt search index survived the restart).

## Launch asks (2026-10-11, not briefed)

Game facts for the Bangumi-like catalogue (S, M if per-platform releases); recipe export paging (limit kept, typed); cover rights mark (M, needs media stack and rights takedown; contract in source-lifecycle); board tags and primary board as Statements with a filtered thread read (M, needs G-1618 and G-1591). G-1593, G-1618 and G-1591 are A (public API shape before opening, no compatibility layer).

## Specifications (read-only analyses, 2026-10-11)

- [Search cluster and idle deadline](reports/G-1632-specification.md): causes of the red SEARCH IDs and the evidence plan for the idle deadline.
- [Recipe refusal after earlier files](reports/G-1637-specification.md): the missing membership preparation proof, the operator restore gap.
- [Graph, claim and model cluster](reports/G-1639-specification.md): two product fixes, six fixture corrections, three deferred.
- [Structure and discovery cluster](reports/G-1640-specification.md): fixture and harness repairs, two evidence investigations.
- [Closed by default without a default decision: the recommended projection rule](reports/G-1697-specification.md).
- [Owner, relay and outbox cluster and the deferred-forever projection class](reports/G-1641-specification.md).
- [Claims into Statements: bounded work and the cutover boundary](reports/G-1698-specification.md): scheduled after opening.
- [Provider identity in slices](reports/G-1643-specification.md): fifteen A slices and three native builds for the unseen-provider proof.

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
