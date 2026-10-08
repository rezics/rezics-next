# State

Checkpoint 2026-10-08 ~08:00 UTC. Manager `kernel-sonnet` (Claude, interactive; tmux `goal-kernel`), who took over from the Sol manager when both Codex accounts ran out (about 6 days; reset credits are forbidden). The coordinator is stopped; the manager keeps `scripts/goal/next-event.sh kernel` running. Live truth: `task goal -- status`; mail: `task goal -- mail inbox kernel`. The earlier per-event log is in git history (`git log -p -- docs/goals/kernel/state.md`).

The Goal is active. C4–C6 and the completion criteria are not proven; the landed pieces below are component proofs, not whole contracts.

## Routing while Codex is out

Workers go to `grok` (implementation, fixtures, mechanical work). Sonnet takes only assertion integrity, contested evidence and correctness-critical slices, at most 2 at once. No Sol or Luna. Land reviews run on Sonnet. Keep the manager's turns lean and delegate wide reading to subagents.

## Merge gate

The unit gate classifies inherited failures against the stream's first-merge baseline, which is now stale: tests such as `g-847-reading-position`, `g-954`, `g-1021`, `nested-pool-checkout`, `owner-response` and `claim-statement-fold` fail identically on current `main`, so a branch is blamed for them (Program was mailed, key `kernel-gate-stale-baseline-1008`). Procedure used: run the branch's own tests, show that the listed failures reproduce on `main` with the same counts, then `task goal -- merge <id> --skip-unit-gate` (add `--allow-scope` when claims lag behind the landing). Native, model or migration landings must be followed by `task dev:refresh -- --wait`.

## Landed 2026-10-08

- G-1352 structure-schema fixture, G-1379 Structure object-coverage group descriptor, G-1373 contribution draft/history original-create receipt reader, G-1345 Claim fold original-inventory receiver (authenticated progress, final deadline recheck; it also repairs four `claim-statement-fold` tests that fail on `main`).
- G-1282 native Claim fold plus Title candidate union with the `ExternalFixture` JUnit category (package excludes it, the existing native wrapper runs it), pin `rezics/fuseki:6.2.0-cmd0.5.39-972ae0d9c953`. Proof: image package 388 tests, 0 failures, wrapper 61 tests, 0 failures, TS 24/24, guard 5/5. Shared stack refreshed and healthy.

## Open work

- **G-1290 joined test** (`tests/qa/integration/title-candidate-original-custody.test.ts`): original SQL-issued Title custody through native acceptance and lost-ACK lookup. Now runnable on the new image; branch `goal/g-1290` holds only this test.
- **Claim fold closure (G-1345 line):** creator acknowledgement, evidence-to-revision, retained body custody and seek reconciliation are still `unresolved`; the receiver returns `complete:false`, `release:'denied'`. Next slice needs a Sonnet worker on authentic owner closure. Mixed converted-Claim QA files fail the harness's raw CLEAR ALL; run the original converting file isolated (Program has the isolation request).
- **G-1373 line (private original source):** an edit receipt is never reconciled (`readExactContributionDraft` does not read `textContributionEditReceiptIri`), there is no edit-actor source, and private bodies have no native external-document delivery. Falsifier test staged in `.temp/worktrees/g-1373/.temp/goal/private-original-source.test.ts`; it needs a worker.
- **Episode-number seek on work-composition (deferred 2026-10-08):** `traversal.ts` refuses numeric queries on work-composition manifests because no production reader exists (needs Resource-local promotion of `schema:episodeNumber`, a number-keyed `QualifierKey` posting with checkpoints, `readCompositionNumberPage` modelled on `readCompositionOccurrenceByQualifierKey`, a typed normalizer, then Launch's one `traversal.ts` call). Launch confirmed it is not needed for the first public launch (the chooser says number jumps are unavailable); Program was told. Not scheduled. G847's Statement seek is a fixture matter: `rebuild()` then `projectOnce()`, owned by Launch G-1421.
- **G-1379 line:** a real stage-64 proof of the group-only Structure descriptor is still owed.
- **G-1300 closure** needs the original G847 integration (Launch G-1421 wires production Statement seek).
- **Pending API decision (Launch de499):** publication of a no-notes Recipe. Authored own-work stays private absent selected public text or `catalogueVisible`; the Recipe reader uses Work disclosure then selected Structure. Needs a generic structured publication with optional notes, not filler text, a relaxed `empty_body` or a Recipe-specific backend. Decide the capability, then coordinate the UI with Launch.
- Whole-Goal remainder: 18-family and current-model convergence, external search copies and physical population locality, Discover remeasurement, exact populated restore/erasure/startup, record §10 list, reciprocal source promotion.

## Loans and boundaries

- Trust-ops owns Comment/Verification C6 erasure (G-1408, G-1411); never edit `erasure`, `content.ts` or the barriers concurrently.
- Launch owns the G-1421 original G847 fixture wiring; all its assertions stay.
- Program owns wider owner regressions and gate diagnostics (G-1417). Kernel fixes only failures it identifies as its own.
- Preserve peer edits and frozen originals; the vault is manager-only; the memory floor is 12 GiB for up to 24 host workers; no worker `--heavy`.
