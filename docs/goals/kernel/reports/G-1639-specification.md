# Graph, Claim, Context and model failure specification

Analysis of commit `d1a29f086`, 2026-10-11. No product source or committed test was
changed. Each implementation item below is sized for one Luna/max session.
A means an incorrect or incomplete product function; B means a fixture or
expectation correction that can follow opening; C means deferred work whose
owner or missing evidence must be resolved before a product change.

Two product fixes are ready to dispatch: cached bytes used as recovery custody
proof and malformed native-child recovery SPARQL. Six items correct stale fixtures
or expectations. A third confirmed defect, incomplete summary cost accounting,
is deferred because its public contract conflicts with hidden/absent privacy.
The model-generation race belongs to the raw-update migration;
the Statement seek journal failure needs its missing source evidence. The Claim
fold deletion at `988ca2c8f` is not established as a cause of these failures.

## Reproduction record

Every command selected one file, through
`bun scripts/goal/goalctl.ts test <path>`, with console output under `.temp/`.
The source-child fault/recovery file is included because that is the file in
the run-9 invalid-SPARQL cluster; the similarly named integration file is a
different surface. QA run artifacts are under `.artifacts/qa/<run-id>/`.
Several independent delegated requests overlapped in the admission queue;
all selected files alone and relied on the existing host slot scheduler.

| File stem | QA run | Result | Console log |
|---|---|---|---|
| claim-template | 20261011t080737-d58b3f | Fail: terminal replay analysis is null; 153 assertions | .temp/claim-template-repro.log |
| graph-query-cases | 20261011t082449-e27526 | Fail: invalid Statement DefinitionRef; 123 assertions | .temp/graph-query-cases-repro.log |
| context-advanced-cases | 20261011t080744-8ed044 | Fail: 2 pass, 5 fail; fake pins return target_unavailable 409 | .temp/context-model-context.log |
| semantic-generation | 20261011t080919-ff9497 | Fail: bulk case passes, race expects 409, receives 202 | .temp/context-model-semantic.log |
| owner-operations | 20261011t082827-d8df4f | Fail: recovery expects unavailable, receives matched; relocation case passes | .temp/context-model-owner.log |
| resource-summary | 20261011t080743-7d97f0 | Fail: 2 pass, 3 fail; startup succeeds; avatar and cost failures | .temp/diagnosis/resource-summary.log |
| catalog-descriptions | 20261011t080748-ac6367 | Fail: expected 2 graph reads, received 3; 9 assertions | .temp/catalog-descriptions-reproduce.log |
| export-source-vndb | 20261011t080856-ea1887 | Fail: first export case passes, LIVE07 expects 201, receives 409; 54 assertions | .temp/export-source-vndb-reproduce.log |
| source-field-child (integration) | 20261011t080900-6e0398 | Pass: 1 test, 51 assertions | .temp/source-field-child-integration-reproduce.log |
| source-field-child (fault-recovery) | 20261011t080906-9fe2d4 | Fail: authenticated recovery command invalid SPARQL; 22 assertions | .temp/source-field-child-fault-reproduce.log |

Paths are `tests/qa/integration/<stem>.test.ts` except the explicitly marked
fault-recovery file, which is `tests/qa/fault-recovery/source-field-child.test.ts`.
Every completed run reported source stable. Artifact test logs are
`logs/integration-1.log`, except fault-recovery's `logs/fault-recovery-f1.log`.
The graph and owner run IDs were assigned on admission; earlier queue labels
in console logs are not their completed QA IDs.

Run-9 evidence was read without modifying the main checkout. Its cited
`.temp/goal-program/run9-acceptance.json`,
`.temp/goal-program/run9-failure-clusters.json` and regression directory
`.temp/goal-orchestration/regress/20261010t200744-9ae88e/` are absent in this
worktree. The failure-cluster JSON differs from the brief: IAM37 and LIVE07
are assertion mismatches; only the fault/recovery LIVE04 file reports invalid
SPARQL, and it fails on the authenticated command endpoint.

Reproductions establish the current failures, not that these unimplemented
changes make a whole acceptance ID green. Run the named proof files after each
implementation; preserve their denial, stale, partial and recovery assertions.

## 1. Durable Claim assessment replay — B

**Cause:** stale expectation introduced by the test retaining a completed
analysis decoration after `2cde9e7a3` made terminal replay independent of the
former analysis basis.

**Acceptance IDs:** FACT01, FACT02, FACT03, FACT04, FACT06, which share the
bundled test in `tests/qa/integration/claim-template.test.ts:25`.

**Files and exact change:** in
`tests/qa/integration/claim-template.test.ts:531–539`, preserve the completed
first response's 41-node proof at line 532. Change the terminal-replay comment
and expectation at lines 535 and 538 to require `analysis: null`,
`replayed: true`, the same assessment identity, and the same activation,
receipt and source position returned by the completed response. Expand its
local response type if needed to compare those fields.

The owner already makes this decision in
`services/main/src/modules/verification/operations.ts:879–892`: durable
terminal replay returns the recorded outcome and does not recalculate analysis
under a new basis. Do not re-run lineage analysis or store another summary to
satisfy the old assertion. Partial replay at test lines 523–526 still returns
its saved continuation and must remain unchanged.

**Proof:** run the changed `tests/qa/integration/claim-template.test.ts`.
Retain the existing cases in
`tests/qa/integration/verification-assessment-producer.test.ts:510`
(lost acknowledgement and superseded positive generation) and line 572
(negative/no-activation immutable terminals); extend those existing cases only
if the replay-with-unavailable-basis guard is missing. No new test file required.

**Priority reason:** B; the failing assertion contradicts intentional replay
semantics, rather than exposing a missing product capability.
**Mechanisms: none.** Reuse the immutable terminal and saved partial continuation.
**Native image build: no.**

## 2. Graph query Statements need authored definition pins — B

**Cause:** stale graph fixture sends
`https://rezics.com/definition/personal-link-v1` and analogous strings as
Statement DefinitionRefs; `b77c9bbc9` requires exact native DefinitionRevision
pins and binding between the relation definition's component and its predicate.

**Acceptance IDs:** GRAPH01, GRAPH02, GRAPH03, GRAPH04, GRAPH05, bundled in
`tests/qa/integration/graph-query-cases.test.ts:58`.

**Files and exact change:** replace fixture setup at
`tests/qa/integration/graph-query-cases.test.ts:411–437` with one authored
active property definition through the file's existing `createdSemantic`
helper (`component: 'definition'`, `kind: 'property'`, `successor: null`,
`roles: []`). Use its returned component as the shared predicate and its
revision as every Statement's `relationDefinition`. Author separate
interpretation definitions for personal, Realm and private Context meanings,
and use their revision references in Context entries and expected meaning
basis. Grant the referenced semantic components' read scopes as required.

At lines 468–479, remove the fixture helper's conflation of the relation pin
with the Context interpretation definition. At line 527 and the other calls,
all three Statements share the property revision while their Context pins
retain distinct meanings. Update the private-definition non-disclosure
expectation around line 616 to the actual private interpretation revision.
Keep the earlier relation-instance role-query fixture intact.

The contract is implemented in
`services/main/src/modules/statement/qualification.ts:430–449, 499–542`.
Do not accept fabricated references or remove the predicate binding check.

**Proof:** run the changed `tests/qa/integration/graph-query-cases.test.ts`.
Existing guards:
`services/main/tests/statement-qualification.test.ts:581, 655` and
`tests/qa/integration/statement-qualification.test.ts:261` cover exact pins,
wrong predicates, unreviewed qualification and stale/denied admission. No new
test file required.

**Priority reason:** B; migrate the test data to the authored contract.
**Mechanisms: none.** Use the existing Semantic definition owner.
**Native image build: no.**

## 3. Advanced Context fixtures need valid Statement relations — B

**Cause:** stale Context fixtures use random native IDs for relationDefinition
without retained DefinitionRevision data; `b77c9bbc9` now rejects them before
the intended Context behavior is exercised.

**Acceptance IDs:** CTX04, CTX05, CTX08, CTX09, CTX10. Two distinct CTX09
tests fail; CTX10 is carried by the combined CTX05/CTX10 case.

**Files and exact change:** add a small authored-definition setup helper to
`tests/qa/integration/context-fixture.ts`, using the existing pattern in
`tests/qa/integration/statement-qualification.test.ts:59–78`: create an
active property/relation through the Semantic owner, grant semantic read of
its component, and return component plus exact revision. This is fixture
setup, not another definition lifecycle mechanism.

In `tests/qa/integration/context-advanced-cases.test.ts`:

- Lines 21–34: CTX09's first case needs an authored relation component as
  predicate and its exact revision as the relationDefinition. Its later
  relation retirement at lines 107–114 must retire that pin, preserving the
  existing readable-old-Statement/new-adoption-refusal assertions.
- Lines 152, 201 and 208–213: use
  `CLASSIFICATION_PROPOSITION_PROFILE` for CTX04 Statements whose predicate
  is `rv:classifiedAs`.
- Lines 235–266: use the same reviewed classification profile in the second
  CTX09 case; its interpretation DefinitionRef lifecycle remains independent.
- Lines 346–409: use the reviewed classification profile in CTX08.
- Lines 453–484: author the hair/eye property definitions, use their returned
  components as the two predicates/Context relation keys, and their exact
  revisions as the corresponding Statement pins. Classification Statements
  still use the reviewed profile. Update matching expected keys throughout
  that case; preserve its Context overlap and CTX10 behavior.

Do not replace the first CTX09 relation with the reviewed classification
profile: that case deliberately exercises relation-pin retirement. Preserve
the tests' interpretation definitions, authority grants, CAS conflicts,
outbox checks, mixed Context dimensions and independently pinned meanings.

**Proof:** run the changed
`tests/qa/integration/context-advanced-cases.test.ts` and the existing
`tests/qa/integration/statement-qualification.test.ts`. No new test file
required. Fixing the first rejection is not yet proof that every later
assertion remains current; the whole file must pass.

**Priority reason:** B; fixture admission is stale, with no demonstrated
product violation in the target Context operations.
**Mechanisms: none.** Semantic owner setup and the existing reviewed
classification relation are sufficient.
**Native image build: no.**

## 4. Recovery must observe the retained object store — A

**Cause:** product defect from `290ec616e`: a verified digest cache can
satisfy recovery reads after the physical object has disappeared or changed.

**Acceptance IDs:** MODEL11, MODEL26 in
`tests/qa/integration/owner-operations.test.ts:20`.

The test warms the restarted resolver at line 80, then renames the retained
local manifest at line 92. `OwnerOperations.configuredWorkObjects()` at
`services/main/src/modules/owner/operations.ts:128–140` configures the S3
reader from the QA environment. Its earlier S3 miss falls back to local
bytes in `services/main/src/modules/work/history.ts:151–169`, remembering
them in the digest cache. Later reconciliation at
`operations.ts:705–706` receives the cached manifest through
`services/main/src/infrastructure/immutable-objects.ts:299–308`, returning
`matched` instead of `unavailable`.

**Files and exact change:** wrap the reconciliation's
`readExactWorkRevision` call at `operations.ts:705–706` in the existing
`withoutVerifiedImmutableObjectCache` helper. Apply the same physical-read
requirement to `services/main/src/modules/owner/object-coverage.ts:166–238`,
where `exactBytes` currently reads Structure objects at line 185 and Work
objects at lines 216–217 through cached `.get()` calls. Use the helper
around those retained-store reads, preserving signal/byte bounds, integrity
checks, typed failures and the existing permitted local fallback.

The helper already exists at `immutable-objects.ts:149–151`; physical
presence uses it in `services/main/src/modules/erasure/replay-objects.ts:32`.
Do not clear the global cache only in this fixture, turn caching off for
ordinary reads, or treat local absence as failure when the selected S3
store genuinely retains valid bytes.

**Proof:** run `tests/qa/integration/owner-operations.test.ts` unchanged
first. Its missing and corrupt manifest assertions at lines 92–107 must
observe `unavailable` and `corrupt`; its restored/restarted and idempotent
outcomes must remain valid. Add
`services/main/tests/owner-recovery-cache.test.ts` to cover warm-cache
retained-store loss/corruption for reconciliation and object coverage,
including Structure storage and source/target retention namespaces: a warm
source digest must not establish presence in an absent or corrupt target store.
Include valid selected S3 bytes with no local file, and preserved abort/byte-limit
handling. The cache's digest-only key spans prefixes, so relocation coverage
is another instance reached through the same exactBytes fix. Reuse the transport/cache
test fixtures from `services/main/tests/immutable-object-cache.test.ts`.
The object-coverage instance is established by source audit, not a separate
executed failing case in this analysis.

**Priority reason:** A; a false custody proof can release recovery with
missing retained bytes. Keep this in one focused session covering both
instances of the same invariant.
**Mechanisms: none.** Reuse the existing cache bypass and recovery outcomes.
**Native image build: no.**

## 5. Model-generation race uses raw SPARQL — C, raw-update ownership

**Cause:** raw-update harness assumption plus classifier omission from
`b0d166136`: the race fixture calls `.update()`, but its file is absent
from `rawSparqlIntegrationFiles` and therefore starts on the product
assembler with no update endpoint.

**Acceptance IDs:** MODEL21, MODEL22. The first bulk MODEL21 case already
passes in run 9; the combined race case fails.

**Exact affected locations:**
`tests/qa/integration/semantic-generation.test.ts:197–217, 225–226`;
`scripts/qa/isolated-integration-files.ts:196`;
`scripts/qa/stack-environment.ts:68–71`;
`scripts/qa/cli.ts:414–415`;
`infra/jena/fuseki-text.ttl`.
The hook sets `advanced = true` before awaiting the raw update. The
transport error is swallowed as an uncertain dispatch in
`services/main/src/modules/semantic/admitted.ts:100–117`; since the
generation did not move, the intentional response is pending 202, not the
fixture's expected generation_changed 409.

The standalone bulk case passes and the race reproduces 202. Its fresh log
confirms product work-scope assembly but does not print the swallowed raw
transport error; the unavailable update endpoint follows from source, not a
recorded 404 in that log.

**Disposition and exact change:** hand the omitted raw caller to the
classifier owner G-1630 and the race fixture to the raw-update migration
owner G-1636. Stop here as the brief requires. Preserve the race's 409,
generation_changed and no-new-write assertions; replace its raw generation
mutation through the existing model owner as part of that migration. This
report does not invent a second model-generation mechanism or weaken the
pending-transport behavior. The exact replacement command has not been
established here, so this is not an independently dispatchable product fix.

**Proof:** after the owner migration, run
`tests/qa/integration/semantic-generation.test.ts` alone and
`scripts/qa/raw-sparql-integration-files.test.ts`.
**Priority reason:** C in this specification; another owner must finish the
raw-update migration.
**Mechanisms: none** for the diagnosis/classification; a replacement command
must reuse the model owner's decision and be named by that owner.
**Native image build:** no for classification; not established for the full
migration until its replacement surface is specified.

## 6. Statement seek coverage failure — C, cause not yet established

**Observed cause boundary:** run-9 resource-summary fails during fixture
startup because the number/uniqueness of outbox batches does not cover the
DATASET sequence interval required by the saved Statement seek checkpoint.
The evidence does not identify the missing or duplicated sequence or its
producer. Naming Claim-fold deletion or a particular preceding test as the
cause would be a guess.

**Acceptance IDs:** VIEW07, VIEW08.

**Locations:** `tests/qa/integration/resource-summary.test.ts:31` starts
the shared stack; `tests/qa/integration/media-support.ts:136–140` backfills
the directory and invokes `projectOnce()`;
`services/main/src/modules/statement/seek.ts:319–326, 387–401` reads the
DATASET position and demands one batch per intervening sequence.
The reader dates to `392c629b6`; startup projection at line 140 dates to
`8b5cb7804`. These are introduction anchors, not demonstrated culprit
commits. Run-9 QA integration-113 logs show the failure after Release and
report-enforcement-notices; integration-16 shows the same startup failure
after Work contents/metadata. No interval or exact batch identities were
recorded.

**Isolated result:** the standalone resource-summary run does not reproduce
this startup gap. It reaches all five tests: two pass, three fail on the
independent avatar/cost issues in items 10 and 11. This leaves retained state and test ordering as candidate explanations;
it does not establish which producer or fixture violates the interval.

**Exact change:** none justified yet. Do not drop the gap guard, mark the
current high-water covered, run an unbounded rebuild at boot, or blindly
isolate the reader to conceal a possible producer defect. A fresh empty
epoch can initialize coverage at the current high-water in
`seek.ts:372–382`, so an isolated pass alone cannot prove journal integrity
of an existing populated epoch.

**One-session evidence task before implementation:** on the historical
failing shared preparation, capture `access.statement_seek_coverage` for
the epoch, DATASET epoch/sequence, and grouped outbox batch identities and
counts for the bounded interval `prior + 1 .. through`. Record zero,
multiple and wrong-epoch batches and the producing operation/receipt where
present, immediately before/after each preceding file. Then distinguish
a deliberately destructive fixture from an owner command violating its
journal contract. Dispatch a separate implementation once that evidence
names the actual writer or stale checkpoint transition.

**Proof:** existing `tests/qa/integration/resource-summary.test.ts` and
`services/main/tests/statement-seek-progress.test.ts:141` (incomplete batch
does not advance coverage), plus the eventual producer's own existing
test. A new test filename cannot responsibly be named until the producer
is known. No additional diagnostic pair run was authorized by the brief,
which limited this analysis to individual-file reproductions.

**Priority reason:** C; preserve fail-closed behavior until the corruption
source is observed. This blocks a claim that VIEW07/08 are repaired in a
shared regression, even if their isolated run succeeds.
**Mechanisms: none.** Existing coverage and immutable outbox evidence suffice.
**Native image build: no** for this evidence task; unknown for a subsequent
fix until its source is identified.

## 7. Content draft query budget expectation — B

**Cause:** stale cost assertion after `aca04b962` added admitted Content
target resolution while retaining the pre-admission and dispatch guards.

**Acceptance ID:** IAM37.

**Files and exact change:** at
`tests/qa/integration/catalog-descriptions.test.ts:99`, expect three
foreground graph reads instead of two. Prefer
`2 + CONTENT_TARGET_COST.graphReads` from
`services/main/src/modules/content-publication/draft.ts:62`, with the
reason expressed as one owner-target resolution plus the two existing
freshness guards. The implementation resolves at line 246, checks before
registration at line 249 and checks again before draft CAS at line 298.
Do not remove either guard to preserve the obsolete number.

**Proof:** run the changed
`tests/qa/integration/catalog-descriptions.test.ts` and existing
`services/main/tests/content-target-resolver.test.ts:45–56`, which proves
one bounded resolver read. No new test file required.
**Priority reason:** B; observed cost reflects the added owner check.
**Mechanisms: none.** Existing resolver and admission/dispatch guards.
**Native image build: no.**

## 8. VNDB Context classification fixture pin — B

**Cause:** stale LIVE07 fixture supplies a fresh random relationDefinition
for each `rv:classifiedAs` Statement; `b77c9bbc9` requires the reviewed
classification profile or a real definition bound to its own predicate.

**Acceptance ID:** LIVE07.

**Files and exact change:** import `CLASSIFICATION_PROPOSITION_PROFILE`
in `tests/qa/integration/export-source-vndb.test.ts:9–10` and replace the
random `relationDefinition` at line 207 with that constant. Remove the
then-unused `nativeId` import at line 21. Use the same relation pin in
both Realm-context Statements. Preserve the distinct selected Context
meanings, their inclusion in the export, and non-disclosure checks.

This also makes the meaning-key inequality at lines 212–215 prove that
the Context interpretation differs, rather than succeeding trivially
because the relation pin was randomized on every call.
The reviewed exception is explicit in
`services/main/src/modules/statement/qualification.ts:513–529`.

**Proof:** run the changed
`tests/qa/integration/export-source-vndb.test.ts`; existing
`tests/qa/integration/classification-vocabulary.test.ts:148–153` shows
the supported predicate/profile pair. No new test file required.
**Priority reason:** B; repair the fixture without widening admission.
**Mechanisms: none.** Existing classification proposition profile.
**Native image build: no.**

## 9. Native child recovery INSERT scope — A

**Cause:** product defect in `d56e7a7b2`: both adoption and retirement
recovery close the outer SPARQL INSERT before their remaining named graphs.

**Acceptance ID:** LIVE04 in
`tests/qa/fault-recovery/source-field-child.test.ts`. The separate
`tests/qa/integration/source-field-child.test.ts` proves ordinary commands,
not held replay.

**Files and exact change:** in
`services/main/src/modules/source/child-recovery.ts:155, 194`, change
`INSERT { GRAPH ... { ${recovery.insert} } }` to
`INSERT { GRAPH ... { ${recovery.insert} }`.
Remove only the final outer closing brace from those two lines.
The existing closing braces at lines 163/196 then correctly enclose
the current/revisions graphs and retained receipt/outbox envelope.
Do not change recovery cursor, guards, original receipt identities or
sequence values.

This is `commandWithReceipt` at line 212 rejecting invalid SPARQL,
not a fixture calling the raw update endpoint. Both branches were
changed in the same commit; repairing only the first leaves retirement
replay broken. The adjacent recovery templates audited for the same
`recovery.insert` pattern do not show this premature close.

**Proof:** run `tests/qa/fault-recovery/source-field-child.test.ts`.
Its lines 110–121 exercise adoption replay, duplicate replay and retirement
replay after earlier missing/prior/denial checks. Also run
`tests/qa/integration/source-field-child.test.ts`. Extend the existing
fault/recovery file with the paired-cut variant if its current unpaired
cut is the only replay path; no new test file is needed for the syntax
repair itself.

**Priority reason:** A; valid retained native-child recovery cannot complete.
**Mechanisms: none.** Existing recovery cursor and native command envelope.
**Native image build: no.** Only TypeScript update construction changes.

## 10. Public avatar fixture shares a private attachment — B

**Cause:** stale fixture after `f311c92de` enforced the media asset's full
current attachment audience. One asset is selected on both the public and
private Work, so anonymous readers correctly receive fallback for the
public Work too.

**Acceptance ID:** VIEW07. The standalone failure is
`tests/qa/integration/resource-summary.test.ts:63`.

**Files and exact change:** at that test's lines 55–57, upload a second
distinct PNG asset for the private Work (for example a separate
`png(128, 128)` upload), and select it for `hiddenSelection`. Keep the
original public asset on `shown`. Preserve the private Work, anonymous
denial, signed-in read, selection history and fallback assertions. These
checks intend to prove each target's audience independently.

The owner rule is already explicit in
`services/main/src/modules/media/visibility.ts:24–25, 124–126`;
`services/main/src/modules/media/store.ts:284–308` enumerates attachments.
Do not weaken the rule that a public occurrence cannot widen a private
attachment's audience.

**Proof:** run the changed `tests/qa/integration/resource-summary.test.ts`.
Keep `tests/qa/integration/media-visibility.test.ts:53, 142`, which explicitly
proves that a second public occurrence cannot widen a private draft's
audience. No new test file required.
**Priority reason:** B; the fixture's expected public image contradicts
the intended all-attachments audience.
**Mechanisms: none.** Existing media audience decision.
**Native image build: no.**

## 11. Summary cost accounting conflicts with the privacy envelope — C

**Cause:** incomplete product cost accounting. The isolated mixed batch at
`resource-summary.test.ts:309` measures 14 graph reads against a reported
6 plus the correct three transport reads (expected 9). Source tracing accounts
for the five omitted reads as two exact-head/parent snapshots and three nested
media attachment summary reads. That decomposition is inferred from the
fixture's branches, not captured per-query fingerprints. The undercount itself
is measured. This is not grounds to remove audience or freshness checks.

**Originating commits:** `3160256a1` introduced disclosure head snapshots
(the expanded parent lookup at `63087c6be`), without summary counting that
path. `f311c92de` added media attachment summary reads, also without
propagating their costs. `5b174de31` restored the initial disclosure pass;
the old fixed budgets now also omit the two intentional name-owner probes.
These are distinct contributions, rather than an attribution to the
Claim fold or Statement index.

**Acceptance ID:** VIEW08, with VIEW07 avatar behavior preserved.

**Read evidence:** `services/main/src/modules/disclosure/read.ts:288–335`
builds an exact resource inventory for missing heads/parents and performs
one graph query per 64 resources. The mixed fixture contains Main Version,
Space, Concept and absent identities requiring this inventory in each
disclosure pass. `media/visibility.ts:96–116` calls
`readResourceSummaries(..., channel: 'media')` for the requested assets'
attachment targets. That nested public-Work batch spends a graph projection
plus two name-owner probes. Neither path reaches the outer summary's
manual cost increments. The transport's admission gate plus the two
position checks in `reading-position/read.ts:93–110` remain the fixed +3.
ReadingBoundary's revelation lookup/fences use SQL and do not explain
the missing graph reads in this fixture.

**Why no implementation is yet dispatchable:** reporting the currently
omitted head-query cost would break another established contract.
`services/main/tests/summary-hidden-envelope.test.ts:77–90` requires hidden
and absent native IDs to return equal public cost metadata. The hidden
Work descriptor has a known Work/head, so the initial exact-head inventory
is empty; an absent ID has neither, so it incurs an additional head query.
Both eventually return the same unavailable item. The current manual
counter masks that real difference. Replacing it with actual counts would
expose existence through the response. Adding queries solely to pad the
hidden path is not a justified remedy.

The standalone naming case also fails at
`resource-summary.test.ts:446`: reported graphQueries is 7 against the old
<=5 ceiling. That ceiling is stale after the initial/final name-owner
checks, but fixing it alone leaves the confirmed accounting defect and
privacy contradiction. Later size/Context cost vectors are not observed
because line 309 stops their case first. This section does not guess their
new values.

**One-session decision/evidence task:** the resource-summary/disclosure
capability owner must record which meaning the public cost field carries
for unavailable targets, then make one concrete design reviewable:
(a) actual owner round trips with one unified, necessary exact-target
head/name-owner read for every native requested identity, reusing its
snapshot rather than introducing padding; or (b) an explicitly defined
privacy-safe public cost envelope, with exact actual spend retained in
internal budget/telemetry. Option (b) changes the existing “round trips
spent” meaning and the test's equality to physical queries; it must be an
explicit owner decision, not a quiet expectation adjustment. Compare these
against the existing `noteNameProbe` and `readInventory` implementations;
do not add another audience or budget decision.

Collect per-query fingerprints and per-owner counts for known readable
Work, hidden Work, absent native ID, Main Version/Space/Concept, paired and
fallback anonymous-name adapters, with and without configured attachment
gates, at sizes 1/16/64. The current mixed case measures 14 graph reads:
11 owner reads and three transport reads. This provides the falsifying
example, not the settled public representation. Deliver the chosen field
meaning, exact propagation/reuse changes and measured bounds as a separate
one-session implementation specification. No product edit is prescribed
until that owner decision exists.

**Candidate implementation locations after that decision:**
`services/main/src/modules/disclosure/read.ts:276–369`
(its existing inventory result can carry head and nested cost metadata);
`services/main/src/modules/media/visibility.ts:96–116`
(propagate costs returned by attachment summaries);
`services/main/src/modules/media/summary.ts:115–116, 460–462, 502–505, 737–745`
(replace incomplete bookkeeping/obsolete cost comment);
`tests/qa/integration/resource-summary.test.ts:309, 318, 354–365, 446`
(measured totals, exact vectors and fixed scaling).
No extra audience evaluation is needed merely to report its cost.

**Proof criteria:** `tests/qa/integration/resource-summary.test.ts` must
retain fixed costs across sizes and unrelated 50,000-slot growth, indexed
selection probes, and both disclosure passes.
`services/main/tests/media-summary-disclosure.test.ts` should compare
physical calls and the chosen contract for head inventories, fallback
anonymous adapters and configured attachment gates; its plain Work fixture
currently avoids head inventories, so it cannot prove this case.
`services/main/tests/summary-hidden-envelope.test.ts` must retain
indistinguishable hidden/absent public responses and gain recorded actual
query counts so the distinction cannot be hidden by an incomplete mock
counter. Extend these existing files; no new filename is required.
This specification did not execute those neighboring proof files.

**Priority reason:** C for dispatch; the undercount is a confirmed incomplete
product function, but a naive repair violates an existing privacy contract.
The missing evidence is the chosen public cost meaning and a measured design
satisfying it. Owner lookup places all three product files in Goal trust-ops's area;
`media/summary.ts` and `media/visibility.ts` are claimed by exited G-1626,
while `disclosure/read.ts` is unclaimed. The kernel manager must coordinate
with trust-ops and that existing ownership rather than send this unresolved
choice to a fixture-only session.
**Mechanisms: none** for the evidence task. Reuse owner snapshots and existing
budget/cost metadata; any change in public field meaning needs the owner's
explicit decision.
**Native image build: no** for the evidence task. The cited alternatives
affect TypeScript reads/contracts, not the native command image.

## Dispatch order and remaining qualification

Implement items 4 and 9 first. Items 1, 2, 3, 7, 8 and 10 can be independent
fixture/expectation sessions. Route item 5 to raw-update ownership and
keep item 6 deferred until its interval evidence exists. Assign item 11's
public cost/privacy contract decision before prescribing its implementation.

All implementation proof commands should use the Goal QA entry point, one
file at a time. The listed neighboring proof files outside a worker's claim
belong to manager qualification; this analysis did not run them. No typecheck,
lint, documentation check, whole-tier run or dev server was started for this
read-only specification. No schema, migration, route, authored model profile
or new tool is prescribed by the ready-to-dispatch items; item 11 cannot
settle its public field semantics without an owner decision.
