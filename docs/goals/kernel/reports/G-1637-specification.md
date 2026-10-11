# Recipe refusal after earlier integration files

The refusal is a **missing ordered-membership preparation proof**, not a rejected
Recipe shape, changed model head, or invalid ingredient reference. Preserve the
native refusal. Isolate the proof-invalidating fixture, expose the bounded native
reason, and prepare restored membership before operator recovery declares it
ready. These are separate implementation sessions.

## Evidence and reproduction

Analysis date: 2026-10-11. Product and test sources were not edited. Temporary Bun
instrumentation in `.temp/validation-diagnostic/` records the unmodified
`FusekiClient.command()` result before the caller constructs `CommandRejected`;
its `result.report` is therefore the report discarded by `typedRefusal`.
Temporary artifacts and instrumentation are not committed.

Command, run through the required Goal QA entry point, with one shared shard:

```sh
REZICS_QA_SHARDS=1 bun scripts/goal/goalctl.ts test \
  tests/qa/integration/realm-submission-api.test.ts \
  tests/qa/integration/recipe-work-page.test.ts \
  tests/qa/integration/g-829-public-reads.test.ts \
  tests/qa/integration/recipe-update.test.ts
```

The local invocation also set `REZICS_QA_ARTIFACT_ROOT` to
`.temp/validation-diagnostic/qa` and prepended the temporary diagnostic Bun shim
to `PATH`. It adds a logging preload; it does not replace validation.

- Run `20261011t072343-a242af`: the harness sorted the files, and Bun actually ran
  G-829, Realm submissions, Recipe update, then Recipe Work page. The shared
  shard had four failures: both Recipe update cases and two Recipe Work page
  cases. Every captured report was exactly
  `populated ItemList requires completed membership preparation`.
- The automatic fresh-project reruns passed: Recipe update, **2/2**, 44.8 seconds;
  Recipe Work page, **3/3**, 20.5 seconds. The harness's final integration status
  was **passed after isolation**, not a clean shared-database pass. Shared test
  time was 58.9 seconds. Evidence:
  `.temp/validation-diagnostic/qa/20261011t072343-a242af/logs/integration-1.log`,
  `integration-r1.log`, `integration-r2.log`, and `rejections.jsonl` in the
  diagnostic directory.
- Exact requested-order reproduction `20261011t072913-f689be` is queued at
  QA startup admission. Its temporary runner invokes the four unchanged files
  sequentially against the same stack and merges their JUnit reports. Source
  checks and the differently ordered first reproduction establish the cause;
  this queued run has not yet supplied requested-order or marker-transition
  observations.

For the first failed Recipe update command, the exact native list focus was
`urn:rezics:item-list:409072ea74329f6bc5d0d2c05993208b989de006d3ae3a348f510896d69a519b`,
owned by Structure `https://rezics.com/id/cf545410-8a65-868e-974a-cdc2b70c14c5`
and generation `https://rezics.com/id/10cb2aa7-70d9-8246-969e-8d332407ca91`.
Its two ingredient placements already existed. The rejected command adds its
first step, at `recipe-update.test.ts:76`; the prior two-ingredient insertion at
line 68 succeeded. The envelope includes the `structure-composition-v1`
`item-list-shape` and `recipe-structure-v1` `step-shape`, but **neither is the
rejecting shape**: the native membership precondition refuses first.

The state transition is explicit in source:

1. G-829 first inserts a temporary protection fact at
   [g-829-public-reads.test.ts](../../../../tests/qa/integration/g-829-public-reads.test.ts),
   lines 304–308. Subsequent DELETEs remove the probe facts, but cannot restore
   the global proof. The raw endpoint appends an unconditional deletion of
   `membershipCompletedForm` in
   [TemplateIndexService.java](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java),
   lines 891–899. Its retained uncommitted SemanticDefinition at test lines
   317–319 is not the rejecting focus.
2. Earlier compositions keep the dataset populated. In
   [MembershipNormalFormPolicy.java](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/MembershipNormalFormPolicy.java),
   lines 87–91, neither a valid proof nor globally empty membership exists.
   The first insertion into a newly empty parent passes its local absence
   witness. It cannot certify the rest of that database.
3. At lines 216–225, a later insertion finds one existing parent member and
   refuses without walking the parent population. The native error contains no
   SHACL shape/focus report; the envelope and staged membership edge identify
   the exact list. This happens before canonical/request SHACL checks in
   `CommandService.java`, lines 1040–1086.

This refusal is intentional. Existing
[MembershipSeekTest.java](../../../../infra/jena/command-module/src/test/java/com/rezics/jena/MembershipSeekTest.java)
lines 723–738 require it for an unqualified populated parent; lines 1002–1011
prevent an insertion from certifying corruption outside its bounded focus.
`ProfileRegistry.java`, lines 58–81, loads immutable digest-checked shapes; there
is no observed model/shape head replacement in the preceding suites.

## Session 1 — A: isolate the fixture that invalidates dataset proofs

**Reason for A:** QA schedules a deliberate bypass mutation beside ordinary
product writers, making valid jobs fail for a prerequisite that their fixture
removed. This is an incomplete scheduling declaration. It is brief option (c),
with a more precise cause: proof invalidation, rather than head rewriting.

**Files and change:**

- [scripts/qa/isolated-integration-files.ts](../../../../scripts/qa/isolated-integration-files.ts),
  append before the `isolatedIntegrationFileList` closing line 183 a reason
  comment and `tests/qa/integration/g-829-public-reads.test.ts`. Keep its raw
  assembler declaration at line 241 while the test still performs raw probes.
- [tests/qa/unit/integration-shards.test.ts](../../../../tests/qa/unit/integration-shards.test.ts),
  add a planner assertion over these four existing file names: G-829 is a
  one-file batch and ordinary Recipe writers remain in a shared batch. The
  existing batch-reset owner in `scripts/qa/cli.ts` must reset between them.
  No new scheduler, fixture update endpoint, or Recipe-specific recovery path.

**Proof:** run the planner test, then the four integration files through Goal
QA with one shard; require no order-dependent fallback. Manager regression also
runs `tests/qa/integration/recipe-structure.test.ts` (RECIPE01/02/03) and the run-8
files listed under limits below. Keep native unqualified-parent refusal tests.

**Acceptance:** removes the demonstrated blockage of both Recipe update cases
and Recipe Work pagination. RECIPE01/02/03 and run-8 writers are expected to
benefit when their earlier contaminant is this same fixture; their complete
qualification still needs the manager's regression. Moving each victim to
isolation would conceal the shared-writer prerequisite problem.

**Mechanisms: none.** Reuse `isolatedIntegrationFileList`, existing reset batches
and the native membership preparer. **Native image build: no.**

## Session 2 — A: carry the actual bounded refusal through Main

**Reason for A:** `typedRefusal` is incomplete: it drops the native reason and
calls a membership preparation refusal persisted-profile validation. Production
can also legitimately have an old/unqualified restored population. The native
refusal should remain denied and explainable. This is brief option (b).

**Files and change:**

- [services/main/src/routes/problems.ts](../../../../services/main/src/routes/problems.ts),
  `problem` at lines 135–138 and the `CommandRejected` branch at lines 368–370:
  include a bounded `detail` and a structured optional `validation` object
  `{ path: string | null, constraint: string | null }` for native `invalid`.
  For the captured report, `constraint` and `detail` name
  `populated ItemList requires completed membership preparation`; `path` is
  null. Keep current status/code mappings and denied outcomes in this session.
  Use a generic command-validation title for policy and SHACL refusals alike.
- [services/main/src/modules/agent/profile.ts](../../../../services/main/src/modules/agent/profile.ts),
  lines 22–49: extract/reuse the existing `agentProfileViolation` parser as the
  one shared parser, in new `services/main/src/infrastructure/profile-violation.ts`.
  Keep the Agent export and its current behavior through an alias/re-export.
  Do not create a second parser or return raw report statements, focus IRIs,
  values, labels, or arbitrary unknown objects. Missing/unrecognized reports
  retain the generic response; do not stringify arbitrary report objects.
- [services/main/src/api-contract.ts](../../../../services/main/src/api-contract.ts),
  `problemResult` at lines 87–90: declare the optional bounded detail and
  validation fields so Elysia serialization and generated consumers preserve
  them. Regenerate contracts for verification and restore generated files
  before handoff, per worker protocol.
- New test `services/main/tests/command-rejection-problem.test.ts`: exercise
  `CommandRejected` through the common route error mapper and a declared Elysia
  response schema. Cover the captured native reason, SHACL path/constraint,
  private literals/IRIs being omitted, absent/non-string/malformed reports, and
  unchanged conflict/unavailable responses.

**Proof:** the new test plus existing
`services/main/tests/agent-profile.test.ts` and
`services/main/tests/command.test.ts`; Main and web typechecks after generation.
The API schema/response assertion must prove the details survive serialization,
not only a direct helper call.

**Acceptance:** explains refusals for RECIPE01/02/03 and every command using the
shared mapper. This item alone does not turn an invalid command into 200 or
qualify the Recipe acceptance IDs. Its new tests qualify the diagnostic outcome.

**Mechanisms: none.** Generalize the existing bounded Agent violation parser and
standard problem schema. **Native image build: no.** The wire shape uses existing
problem-details semantics: [RFC 9457 sections 3.1.4, 3.2 and 5](https://www.rfc-editor.org/rfc/rfc9457.html)
allow explanatory detail/extensions while calling for care with exposed data;
they do not prescribe this product's fields or status selection.

## Session 3 — A: finish operator restore's existing membership preparation

**Reason for A:** source establishes a production readiness gap distinct from
the QA fixture. `TemplateIndexService.java`, lines 502–510, rejects an old
proof's epoch after restore. `MembershipSeekTest.java`, lines 788–811, explicitly
requires preparation after the restore hold is released. Operator recovery
currently enables owner logins and returns verified without doing that work.
The resulting populated restore/Recipe-write scenario has not been executed
in this analysis; this is a source-established missing step, not a measured
production incident.

**Files and change:**

- [scripts/ops/restore.ts](../../../../scripts/ops/restore.ts),
  `finishOperatorRestore` lines 118–170, before owner epoch advancement and
  `ALTER ROLE ... LOGIN`: after authenticated reconciliation has settled
  `reconciled/matched` and both release observations succeed, invoke the existing
  stopped-writer membership preparer on the restored lineage. Confirm its
  current completion status before enabling logins. Keep this outside the
  retained-erasure release transaction: that release binds sequence zero.
  Do not move maintenance receipts into its signed release cut.
- Reuse
  [services/main/src/modules/structure/membership-normalize.ts](../../../../services/main/src/modules/structure/membership-normalize.ts),
  `normalizeStoredMembership` lines 55–70, with the operator's absolute deadline
  capped by `RecoveryBudget.remaining()` and the existing preparation ceiling.
  Iterate its bounded resumable turns until complete or the same budget ends;
  do not grant a fresh 540 seconds on each turn. Use the restored Fuseki client
  and lineage, not the source. No proof may be forged by TypeScript.
- [scripts/ops/tests/restore-erasure-release.test.ts](../../../../scripts/ops/tests/restore-erasure-release.test.ts),
  expand the existing order proof at lines 109–123: preparation and completion
  observation occur after both releases and before enabling logins. Add partial
  progress, invalid preparation, interrupted response, deadline exhaustion,
  completed retry and stale-epoch cases. On failure, never emit verified
  evidence or enable logins; preserve the existing stopped target handling.
  Do not describe Access/graph as still held if their releases already committed.
**Proof:** the expanded operator unit file; Session 4 supplies the populated
recovery qualification before this change is considered complete. Manager also runs
`tests/qa/fault-recovery/owner-restore-erasure-production.test.ts` (OPS12) to
preserve retained-authority/erasure behavior. The native restored-epoch test is
existing evidence; no native implementation change is needed.

**Acceptance:** OPS03's preparation pins, resumed RECIPE01/02/03 behavior, and
preserved OPS12 release custody. No assertion that run-8 contamination is a
restore failure. Installation already awaits `upgradeStoredMembership` in
`scripts/fixture/migrate.ts`, lines 65–68; failover already invokes installation
in `scripts/ops/failover.ts`, lines 152–154. Reuse that owner, not another
normalizer or an online corpus walk on every edit.

**Mechanisms: none.** Existing operator recovery budget and native membership
preparation/continuation. **Native image build: no.**

## Session 4 — A: qualify populated operator recovery (depends on Session 3)

**Reason for A:** the existing OPS12 operator recovery test can report ready
without demonstrating that restored ordered memberships support subsequent
commands. This acceptance gap needs its own session because retained custody,
backup and interrupted recovery fixtures are substantial.

**Files and change:**

- [tests/qa/fault-recovery/owner-restore-erasure-fixture.ts](../../../../tests/qa/fault-recovery/owner-restore-erasure-fixture.ts),
  constructor at line 134, physical snapshot near line 729, restore cutover near
  line 816 and `operatorAttempt` at lines 1051–1058: add a minimal opt-in seed
  hook before the physical cut. Reuse its existing restore copies and operator
  finish adapter; leave default fixture populations unchanged.
- New `tests/qa/fault-recovery/operator-restore-membership.test.ts`: through
  existing product commands seed a populated Recipe before the cut. Capture
  the backup once, retain it consistently, and restore isolated copies. Show
  that the old proof is ineligible for the changed epoch before operator
  completion. After completion, two consecutive inserts and a qualifier edit
  succeed, retaining prior occurrence identities and exact qualifiers. A stale
  expected head remains denied. Inject a preparation interruption/refusal;
  owner logins and verified evidence remain closed, and a resumed finish uses
  the existing native continuation. Observe readiness only after finish.
  Neither raw proof planting nor a new recovery backdoor is a fixture method.

**Proof:** the new fault/recovery file through Goal QA, and manager regression of
`owner-restore-erasure-production.test.ts`. Require the same authority/erasure
release evidence and bounded preparation; reuse the existing ten-minute budget.
Do not certify success from `/health/ready` alone.

**Acceptance:** OPS03 preparation pins and resumed RECIPE01/02/03 operations;
preserve OPS12. The new test qualifies the restored-membership transition, not
all importer/exporter behavior associated with those Recipe IDs.

**Mechanisms: none.** Existing retained-custody fixture, product composition
commands and native preparer. **Native image build: no.**

## Limits and follow-up classification

- **C — run-8 attribution remains unproved.** The cited historical log was not
  present at its translated worktree path. The following were not replayed:
  `tests/qa/integration/g-846-wiki-publication.test.ts`,
  `g-847-reading-position.test.ts`, `g-848-wiki-toolkit.test.ts`,
  `g-1043-feed-readiness.test.ts`, and `g-1051-query-agents.test.ts` (all in the
  same integration directory). Their generic 400s do not establish the same
  report. Capture native results on the manager's next ordered regression;
  this membership reason confirms this fix's applicability, a different reason
  requires a separately scoped specification. No native image build or new
  mechanism is needed merely to capture those reports.
- **C — standalone owner-API readiness beyond operator recovery.**
  `services/main/src/routes/health.ts`, lines 31–37, currently observes Access,
  profile pins and graph hold, not membership completion. The owner API can
  release the graph independently of operator finishing. This analysis has not
  measured a complete standalone recovery/serve journey. Confirm whether such
  a deployment may serve before the required stopped-writer preparation, then
  bind readiness to the existing preparer's status if needed. Do not add an
  independent membership authority or auto-repair in a user command.
- **C — other raw-fixture cleanup classes belong to the existing migration
  work (G-1636), pending runtime attribution.** Source candidates under
  `tests/qa/integration/` include `realm-submission-targets.test.ts`, lines
  58–61 and 86–88; `g-892-collection-grain.test.ts`, lines 127–134;
  `post-author-notes-custody.test.ts`, lines 90–106;
  `content-zone-revision-delivery.test.ts`, lines 143–146 and 168–171; and
  `structure-qualifier-root.test.ts`, lines 67–71. Their raw endpoint calls also
  remove the global proof, even when later cleanup restores the RDF facts.
  Earlier preparation is insufficient if subsequent raw writes follow it
  (`g-920-wiki-readers.test.ts`, `zone-document-home.test.ts`,
  `zone-route-keyed.test.ts`). This audit did not trace every transitive cleanup
  or reproduce their later writers. Class migration should require either the
  existing file reset or completed preparation after the final bypass mutation;
  do not add a blanket new isolation algorithm. Existing complete cleanup in
  `g-704-contribution-loop.test.ts`, lines 565–575, and
  `g-929-wiki-disclosure.test.ts`, lines 464–475, is a counterexample to automatic
  isolation of every file merely listed as raw. Mechanisms remain the existing
  supported command/restore/import owners; no native image build for this audit.
- The full RECIPE01/02/03 integration acceptance and run-8 suites were not
  qualified by the two-case isolated pass. The implementation sessions must
  report their own explicit evidence; the manager owns program regression.
