# State

Checkpoint 2026-10-08 ~08:00 UTC. Manager `kernel-sonnet` (Claude, interactive; tmux `goal-kernel`), who took over from the Sol manager when both Codex accounts ran out (about 6 days; reset credits are forbidden). The coordinator is stopped; the manager keeps `scripts/goal/next-event.sh kernel` running. Live truth: `task goal -- status`; mail: `task goal -- mail inbox kernel`. The earlier per-event log is in git history (`git log -p -- docs/goals/kernel/state.md`).

The Goal is active. C4–C6 and the completion criteria are not proven; the landed pieces below are component proofs, not whole contracts.

## Routing while Codex is out

Workers go to `grok` (implementation, fixtures, mechanical work). Sonnet takes only assertion integrity, contested evidence and correctness-critical slices, at most 2 at once. No Sol or Luna. Land reviews run on Sonnet. Keep the manager's turns lean and delegate wide reading to subagents.

## Merge gate

Since G-1427 (df5a3b7a3) the unit gate compares failing cases with the current main commit the merge targets, by case name, from bun's per-file JUnit report. A file that fails only on the branch is rerun alone on both sides: passes alone is order or load dependent (reported, not blocking); fails alone with a case main does not fail is introduced; a pg_ctl, embedded PostgreSQL or port-bind start failure is inconclusive; any other runner crash refuses. Files a regeneration commit writes are not claims. `task goal -- gate <id>` reruns the pre-merge gate without merging. Do not use `--skip-unit-gate`: when the gate refuses, mail Program the evidence file. A merge can outlast a foreground turn, so run it as a detached unit (`.temp/kernel/merge-unit.sh <id> --allow-scope`, mails `kernel-merge-<id>-result`). Before landing, `task gen` in the worktree and commit the generated files (the merge does not regenerate; native work also needs the new image pin built). Native, model or migration landings are followed by `task dev:refresh -- --wait` (retry once on an `approve-zones` timeout; a refresh that fails a build step now names a 0600 log in the stack directory).

## Landed 2026-10-08

- G-1352 structure-schema fixture, G-1379 Structure object-coverage group descriptor, G-1373 contribution draft/history original-create receipt reader, G-1345 Claim fold original-inventory receiver (authenticated progress, final deadline recheck; it also repairs four `claim-statement-fold` tests that fail on `main`).
- G-1282 native Claim fold plus Title candidate union with the `ExternalFixture` JUnit category (package excludes it, the existing native wrapper runs it), pin `rezics/fuseki:6.2.0-cmd0.5.39-972ae0d9c953`. Proof: image package 388 tests, 0 failures, wrapper 61 tests, 0 failures, TS 24/24, guard 5/5. Shared stack refreshed and healthy.

- Later the same day (all with the branch's own tests and per-case proof against main): G-1423 private Contribution reads reconcile the original create/edit receipts and read the edit actor through the Access module, fail closed (8a4a1cd76); G-1430 anti-silo CreativeWork count restored (aa213b9ba); G-1290 native `workScopeDirectory` prepare command plus tolerant startup caller, original Title custody acceptance passes on the exclusive-writer stack, pin ad8fad6e2794, stack refreshed (532a753e3); G-1433 Recipe work page in 100-occurrence signed-cursor pages, `measures` on every page (73c92bad9).

## In flight

- G-1435 (grok): Bangumi-like facts as data (format concept scheme, declared counts, status `upcoming`/`cancelled`, importer). G-1437 (grok): year literal-fact read template with a native posting in `access.template_seek_entry` (sentinel anchor, inverted year key); native, needs image rebuild, pin, `dev:refresh`. G-1436 (credit roles studio/director/artist, brief written, not dispatched) waits for G-1435 to release `scripts/dev/seed/relation-lexicon-data.ts`. Board tags (Launch P1 class 9) come after these. Mail Launch after each landing.
- Landing checklist: branch's own tests, `task gen` committed in the worktree (the merge does not regenerate), `--skip-unit-gate --allow-scope` with the per-case proof named in the mail, `task dev:refresh -- --wait` for native/model changes (retry once on an `approve-zones` timeout), then close verified.

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

## Update 2026-10-08 (later)

- Landed: G-1446 (15e1d68be), G-1445 (40ba4e279, the Kernel-owned red owner cases from Program's G-1428 bisect), G-1437 year template `work-publication-years` (6d92f2faa; posting in `access.template_seek_entry`, page cost bounded at 5,000 extra entries). G-1437's image `4cc7c568097a` is built and the stack refreshed by the detached unit `rezics-kernel-build-refresh-1437` (self-mails `kernel-g1437-build-refresh-result`); close G-1437 verified only when both exits are 0.
- G-1435 (Bangumi-like facts as data, goal/g-1435 149666d97) is done and tested but not landed: it makes `task web:typecheck` fail at `apps/web/features/recipe-editor/edit-page.tsx(104,75)` (completionStatus gains `upcoming`/`cancelled`), a file Launch's G-1444 claims together with `initial-details.ts`. Launch was mailed (`kernel-g1435-web-blocker-1008`); land after G-1444 widens both files, or on "kernel may edit". It needs `task dev:refresh -- --wait` (facet-status-v2 is a model change). Follow-up: journal `importBangumiWorkFacts` into `importDataset`. G-1436 (credit roles) is dispatchable now that G-1435 has released the lexicon seed.
