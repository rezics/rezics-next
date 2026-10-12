# State

Checkpoint 2026-10-11 14:00 UTC. Manager `kernel-sonnet` (Claude; tmux `goal-kernel`), which took over from the Sol manager on 2026-10-08. The Goal is active; C4-C6 and the completion criteria are not proven. The landed pieces below are component proofs, not whole contracts. Program's target: every A implementation finished by about 23:00 UTC, verification after.

## Routing

Workers are Luna at max for bounded implementation (width 8 live) and Sol (`codex`) for analysis and judgment, `codex-1` as overflow. Cursor quota is spent and Claude is never a worker; no top-ups. Land reviews run on Sonnet. The unit gate decides; `--skip-unit-gate` is never used, and a refusal goes to Program with the evidence. Three attempts, then stop and mail Program.

## Landing recipe

`task gen` in the worktree and commit generated and pin files. Native work needs the pinned image built locally first (`rezics/fuseki:6.2.0-cmd0.5.39-<hash>`; the Maven suite runs inside `docker build -f infra/jena/Dockerfile`, about 20-30 minutes) and then one `task dev:refresh -- --wait`, which Program runs. Rebasing a native branch conflicts on `docs/development/toolchain.md`, `infra/dev/compose.yaml` and `scripts/dev/release-manifest.ts`: take main's, then `task gen`. A guard baseline that a registration move trips (anti-silo) is edited by hand for the moved key only; its own rewrite changes unrelated entries. Helper scripts live in `.temp/kernel/` (`merge-unit.sh`, `chain-test-merge.sh`, `after-then-chain.sh`, `build-image-1546.sh` with `WT`).

## Landed since 2026-10-09

- Search: pre-pin Content receipts (G-1584), interrupted rebuild states (G-1600, G-1613, G-1617), quarantine continuation with a legacy prior receipt (direct fix on main), native command deadline 60 s. The shared stack's public search answers again after a clean 132 s rebuild (2026-10-10 16:45 UTC).
- Claim fold deleted (G-1573); the Claims-into-Statements unification is decided and waits on provider identity.
- Structure profile document is the allowlist (G-1592, pin `ce9c77bee5cd`): a new composition kind registers as data; the section-list proof is `tests/qa/integration/structure-profile-section-list.test.ts`.
- No command seals an idempotency key on a current-visibility outcome (G-1623): the audit table and a source-scan guard are in `services/main/tests/seal-on-visibility.test.ts`. Reference shape: visibility checked before the write answers 404 with nothing written; a target lost inside the write answers 503 unsealed. `TargetUnavailable` stays the hidden==absent 404.
- Erasure of every revision kind, rights T1, conversions, discovery and meter work (see the git history).

## Running and queued (2026-10-11 14:00 UTC)

Inside the window (Program's cuts): eligibility chain (one branch, after the classifier and the reply bridge land), the Zone recovery proof, the structure publication chain (steps in order, Access preview last), imported covers slices 1 and 2 (slice 3 is in Trust-ops' area and waits for the answers on scope), rights notice slices 1, 2 and 5, and seven position repairs (Feed, Discover, notifications, Zone browse, serial summary, ranking input, Realm rankings; the load helper is B). Outside: G-1582, G-1615, G-1603 with its image build, unfinished class-table batches. Parked B: Realm boards, public read mode, Claims into Statements, provider identity, history and undelete for replies and Zone pages, the redacted public decision read, the absent-Realm cost equality, the position-domain load helper, the raw-update migration of roots that are green on the fixture assembler (briefs G-1834 to G-1837 stay unstarted), the 102 model-generation and legacy roots.

## Specifications (read-only analyses, 2026-10-11)

- [Search cluster and idle deadline](reports/G-1632-specification.md): causes of the red SEARCH IDs and the evidence plan for the idle deadline.
- [Recipe refusal after earlier files](reports/G-1637-specification.md): the missing membership preparation proof, the operator restore gap.
- [Graph, claim and model cluster](reports/G-1639-specification.md): two product fixes, six fixture corrections, three deferred.
- [Structure and discovery cluster](reports/G-1640-specification.md): fixture and harness repairs, two evidence investigations.
- [Closed by default without a default decision: the recommended projection rule](reports/G-1697-specification.md).
- [Owner, relay and outbox cluster and the deferred-forever projection class](reports/G-1641-specification.md).
- [Claims into Statements: bounded work and the cutover boundary](reports/G-1698-specification.md): scheduled after opening.
- [Public disclosure cursors and the explicit read mode](reports/G-1713-specification.md): 17 slices, the Launch web handoff.
- [Two races that survive the retryable-refusal fix](reports/G-1679-specification.md): test hook and fixture repairs.
- [Where local consistency is persisted](reports/G-1642-specification.md): defer; eight position-domain slices pending reproducers.
- [Provider identity in slices](reports/G-1643-specification.md): fifteen A slices and three native builds for the unseen-provider proof.
- [Content document recovery](reports/G-1801-specification.md): bad-edit restore already proven; slice 1 the Zone proof repair, slices 2 to 7 B.
- [Publication of a Recipe without notes](reports/G-1802-specification.md): the structure publication chain, eight slices.
- [Raw-update caller classes](reports/G-1828-specification.md): 149 roots, 47 migration candidates by a supported mechanism, 102 without a supported builder; B except roots still red after the fixture assembler selection (Program, 2026-10-11).
- [Gated reads: one admission rule](reports/gated-reads-design.md): rankings, public and private Content search and private contribution search are served or refused by their own scope; 6 to 8 sessions, native capture first.
- [Imported covers: source evidence, rights mark and scoped takedown](reports/G-1800-specification.md): eleven A slices; slices 1 and 2 running, slice 3 in Trust-ops' area, 4 to 11 wait for owner answers now given.
- [Rights notice path](reports/G-1803-specification.md): two API gaps and eight A slices; slices 6 to 8 wait on Trust-ops' erasure chain; the public decision read is B.
- [Pinned catalogue import cost](reports/catalogue-import-cost.md): recipe and bounded Bangumi import measurements, including the refused native episode batch.
- [Bangumi episode reference refusal](reports/anime-episode-reference-refusal.md): the missing Person provisioning prerequisite in the measurement fixture, proven by a two-episode import.

## Open

- Rights T2, T3a, T3b, T4, T5: send each diff to Trust-ops before landing. The Statement create has no licence field (`importBangumiWorkFacts` gap), flagged for T4.
- Abstraction A1b and A1c; ranking projection event poisoning (brief separately); a feed refresh worker answers "failed" instead of "deferred" while public search is unavailable (fold into the next feed change).
- Episode-number seek on work-composition: `traversal.ts` refuses numeric queries on work-composition manifests because no production reader exists.
- Whole-Goal remainder: 18-family and current-model convergence, external search copies and physical population locality, Discover remeasurement, exact populated restore/erasure/startup, reciprocal source promotion.

## Parked

- Parked 2026-10-11 (scope cut, Program with the maintainer): Realm boards (Statement tags, primary board, filtered thread read) are B; the G-1649 specification brief was cancelled before it started, G-1648 (game facts) stays wave 3, G-1591 and the public read mode specification (G-1713) wait for after opening, Claims into Statements (G-1698 plan) after opening.

## Boundaries

- Trust-ops owns Comment/Verification C6 erasure and the hidden==absent inventory; never edit `erasure`, `content.ts` or the barriers concurrently with it.
- Launch owns the realm-reply files (G-1597) and the original fixture wiring; its assertions stay.
- Program owns wider owner regressions and gate diagnostics; Kernel fixes only failures it identifies as its own.
- The vault is manager-only; never switch HEAD in the main checkout; commit explicit paths only; no task IDs in code or comments.
