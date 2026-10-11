# Claims into Statements: bounded work and the cutover boundary

Analysis baseline: `0d95ad3096f37432c8c563483ee731fa95dd96a5`, 2026-10-11.
The source brief is `docs/goals/kernel/tasks/G-1618.md`. All evidence below
comes from this worktree. Line numbers identify the starting symbols; preceding
slices will move them. This report is the only authored change. No product code,
test, generated artifact, database, image or running service was changed.

The target is one representation per authored proposition, a Statement, with existing verification
records pinned to its identity and exact revision. Keep the DecisionSlot and
verification receipts; retire Claim creation, Claim reads and retained-Claim
conversion. An evidence revision or assessment is a verification record, not a
second representation of the proposition. No new case table, verification
framework, Claim-to-Statement converter, legacy URL alias or export version is
needed. **Mechanisms: none** for every slice below.

## What can be promised about landing

The original document's sequence—model deletion, module, routes, export, then
tests—cannot leave each intermediate tree green. Routes import the deleted
module symbols, assessments validate against both profiles, and tests create
Claims through the routes being removed. SQL renames also require their callers
and trigger bodies together. These are compile-time and runtime dependencies,
not a missing provider-identity prerequisite.

The safe specification separates **independently landable preparation** from
**bounded work batches in one coordinated cutover**. Preparation slices 1–3
can preserve current behavior. Batches 4–12 each have a narrow implementation
and proving-test scope, but must be assembled before the cutover is landed.
Do not claim that an intermediate batch passes the whole affected suite or
publish an intermediate image/contract as the completed change.

This does not establish the brief's stronger promise that *every* implementation
batch can independently land green in one Luna session. Making that promise
would require either an additional staged target implementation beside the
legacy implementation, or temporarily translating old bodies/URLs/records.
Neither is specified here: the former duplicates owner work and the latter is
the forbidden compatibility layer. The manager should dispatch preparation,
then retain one integration branch for the bounded cutover batches, with one
atomic green landing. Session sizes below are planning bounds, not measured
Luna throughput. In particular, the full cutover is not a one-session task.

Classes follow `docs/goals/kernel/reports/G-1632-specification.md:24–30`:
**A**, a first-public-scope function is incomplete without the change;
**B**, a function works now or may remain platform-gated while deferred;
**C**, defer or cut. Identity cleanup and platform verification are B in
isolation. Preserving the public export and disclosure when their dependencies
are replaced is an A prerequisite of the chosen cutover, not evidence that
every current Claim endpoint is a broken public function.

## Where the brief and the tree disagree

| Class | Finding and evidence | Consequence |
| --- | --- | --- |
| B | `routes/statements.ts` does not exist. `services/main/src/routes/contexts.ts:63–65,732,818,885` owns Statement creation, reads and withdrawal. | Preserve those operations; put verification subresources in a capability-named module, such as `routes/statement-verification.ts`. Claim its registration in `app.ts`. |
| B | The Claim fold is absent, but its adapters survive in `statement/graph.ts:127–159,367–411`, `qualification.ts:104,207,395,585,596`, `schema.ts:72,86,107`, `projection.ts:117`, and `read.ts:120–135,231–232,345–354`. | Delete the remaining adapter family; do not recreate the fold. `projection.ts` and `read.ts` need claim expansion. |
| B | `statement/seek.ts` has no retained-Claim match in the inspected tree. | No speculative seek edit. Run its owner proof after deleting the adapters. |
| B | Claim creation is still live: `verification/graph.ts:282`, `operations.ts:134`, `routes/claims.ts:133`. `app.ts:180` calls `claimRoutes(work)` without enabling the optional terminal-only option at `claims.ts:109`. | Delete actual writers and routes. The optional `legacyClaimDispatch` at `operations.ts:59,140` does not establish a completed cutover. |
| A prerequisite | `verification/graph.ts:395–447,455–480` can read a Statement only if it has a retained Claim root and receipt, and rejects ordinary Statement meaning at `:432`. | The target verification path must use the existing Statement read owner, not merely rename `ClaimRecord`. |
| A prerequisite | `model/definitions/assessment-v1.ttl:48–52,75–94` still admits Claim and Statement alternatives. `statement-v1.ttl:46,80–89` still references ClaimRevision provenance. | Removing `claim-v1.*` alone leaves Claim semantics and generated revision classes. Assessment definitions/admission tests are missing from the old claim. |
| B | `model/tests/claim-analysis.test.ts:127,140,162,209,236,254` contains lasting verification/admission assertions. `scripts/qa/coverage/fact.ts:9–19` references three exact names in that file. | Port those proofs before deleting the file. Delete only representation-specific characterization. |
| A prerequisite | Public assessment export calls the dual reader at `export/readers.ts:496` and exports two members at `:505–527`. GET revalidation assumes the assessment is member 1 at `export/operations.ts:115–143`. | Writer, rereader, sealed locator, disclosure losses and export proof must change together. |
| B | Later SQL includes `1520_verification_walk.sql:24,77–82`, `1522` challenge functions, and `1704_verification_assessment_producer.sql:23–34,48,64–68`. | A migration based only on 090–096 misses walk state, producer intent and current guards. |
| C | `validation-cross-profile.test.ts:123–124` names **work-address-claim-v1**, not the verification Claim profile. Other model grep hits also concern address claims. | Keep those profiles and proofs. Do not port unrelated claims by substring. |

`G-1618.md` already has `depends: []`. No provider-identity task should be
reintroduced as a dependency. This worktree alone does not establish that
there is no deployed installation; resetting fixture/dev Claims follows the
explicit brief, rather than an inferred production migration policy.

## Target API and actual clients

Retire eleven method/path operations across ten paths: the challenges path has
both POST and GET. `routes/claims.ts:15–25,133–159,182–286` declares:

| Existing operation | Target |
| --- | --- |
| `POST /v1/claims` | Removed; create with existing `POST /v1/statements` |
| `GET /v1/claims/{claim}` | Removed; Statement fields come from existing `GET /v1/statements/{id}`; verification quality needs its own case read |
| `POST .../assessments`, `GET .../assessments/{assessment}` | Same methods below `/v1/statements/{statement}` |
| `POST .../evidence`, `GET .../evidence/{revision}` | Same methods below `/v1/statements/{statement}` |
| `POST .../challenges`, `GET .../challenges` | Same methods below `/v1/statements/{statement}` |
| `POST .../challenges/{challenge}/withdrawal` | Same method below `/v1/statements/{statement}` |
| `GET .../corrections`, `POST .../correction-subscriptions` | Same methods below `/v1/statements/{statement}` |

Specify a case read, `GET /v1/statements/{statement}/verification`, for the
quality/evidence-head information currently returned by `readClaimQuality`
(`operations.ts:899–933`). It is a verification read alongside the existing
public Statement read, with `platform:wiki-agents`, read rate limit and the
existing verification reader authority. It must not replace or duplicate the
Statement response. This is an explicit addition to the old brief, which
otherwise drops the only quality read without assigning its consumer outcome.
If the manager elects to cut that platform read, record that cut rather than
silently losing it while claiming all verification behavior was preserved.

New evidence, assessment and challenge bodies use `statementRevision` in place
of `claimRevision`; their profile literals become `statement-evidence-v1`,
`statement-assessment-v1`, `statement-challenge-v1`, and
`statement-challenge-withdrawal-v1`. The correction subscription literal can
remain `verification-correction-subscription-v1`. Evidence-head CAS remains a
UUID; Statement revision and resource references remain exact IRIs. Responses
use `statement` and `statementRevision` for verification pins, never
`representation`, `referent`, `propositionPredicate`, `claimStatus`, `statedBy`
or a retained root as a second proposition view.

Statement creation already uses `subject`, `predicate`, `relationDefinition`,
`value`, `speaker`, applicability, interpretation, optional qualification and
evidence (`contexts.ts:733–755`). Do not copy these into verification request
bodies. The verifier resolves the pinned Statement through `statement/read.ts`.
Do not substitute the current Statement for an exact historical revision.
Qualifications are optional; there must be no hidden datePublished-only or
retained-provenance gate. Preserve resource, literal, some-value and no-value
states. If a support calculation cannot establish scope or lineage, retain
explicit unknown/insufficient/abstained behavior rather than manufacture
precision, a context, a lexical value or independent origins.

Preserve exposures, rate families, bearer/idempotency requirements and all
existing verification authority decisions. Nine moved method/path operations
remain platform-gated; the subscription remains `platform:update-subscriptions`
instead of `platform:wiki-agents`. Keep source reliability, origins, observation
disposition, lineage/retraction and derivation routes currently declared in
`claims.ts:17,26–31,162–180,289–335`. Retiring the whole route file without
moving these six operations would remove unrelated working capabilities.

Keep the `claim-assess` receipt family, `verification.claim-assess` action,
existing account scopes and assessment/cancellation events unless an independent
authority migration is authorized. Their spelling does not store a second
proposition. `modules/access/assessment-history.ts:5,104` also depends on the
family/action. Delete the `claim-create` family and its results/events. Renaming
all receipt/action/topic terminology is C cleanup; it unnecessarily broadens
the cutover into Access and Notification ownership.

**Launch client inventory:** exact `/v1/claims`, ClaimRecord field and Eden
`.claims(...)` searches found no nongenerated calls under `apps/` or `packages/`.
Launch's `apps/web/features/api/main.ts:2,60` imports `MainApp`, so it is the
first client to typecheck after contract changes, but no direct runtime Claim
route break was established. `features/auth/scopes.ts:30–31` advertises Claim
OAuth scopes; keep the verification scopes still used by the moved operations
and remove only `claim:create` after its last producer is retired.

The web's `claims` collection is already a Statement read:
`routes/graph-queries.ts:175–202`, `modules/graph-query/statements.ts:55–65,257,286`.
Consumers are `features/entity-page/event-participants.tsx:64–72` and
`features/scoped-rating/sources.ts:108–110`. **Keep this property.** Renaming it
would break those clients and `features/entity-page/identity-reads.test.ts:108`
and `apps/web/tests/scoped-rating-pages.test.ts:115–138` without advancing the
proposition unification. Wiki reads use `/v1/wiki/evidence/{id}` at
`features/wiki/read.ts:167`; `packages/wiki-toolkit/protocol/wiki-extraction.ts:60–64`
describes extracted source assertions, not verification ClaimRecord.

## Export contract decision

There is a real public consumer: `routes/exports.ts:20–23,34–35,105,112–113`
accepts assessment selections and returns/reloads a sealed export manifest.
`tests/qa/integration/export-verification.test.ts:121–150` consumes the old
two-member shape, qualified values, redacted evidence and method scores.
`modules/export/README.md:30–33,70–71` documents it. No separate web or external
script consumer of that assessment manifest was established by the searches.

Keep `export-manifest-v1` and target profile `rezics-verification-v1`. The
verification payload in the existing manifest becomes:

```text
{ statement: <the Statement's own exact read shape>,
  assessments: [<selected exact assessment, with statement pins>],
  challenges: [<disclosed records for the selected Statement revision>],
  evidence: [<selected exact evidence manifest, with current availability>] }
```

The selection is still an **assessment**, not a corpus export. Initially the
assessment array contains the selected assessment; do not scan every assessment
for the Statement just to fill an array. Challenges must respect exact revision,
disclosure and existing bounds; never label a truncated list complete. An
empty/redacted collection is accompanied by the manifest's existing loss
records. Preserve the assessment's method, policy, evaluation context,
calibration limits, source pins, recorded/current availability and positions.
The Statement's small authored `evidence` reference list is distinct from the
Content verification evidence manifest.

The reader should serialize this bundle as one verification payload with an
explicit selected-assessment locator, actor and expected owner position for
GET revalidation. Keep locator metadata in the owning manifest, rather than
assuming `members[1]` is an assessment. Keep per-input provenance/loss records
in the existing planner; do not falsely give all inputs one owner sequence.
The exact planner placement is an implementation choice to validate with the
export owner tests; this reading does not prove a new aggregate member is
rights-equivalent to two independent members. Payload and locator belong in
the canonical plan before its digest and byte bound are computed
(`planner.ts:80–91,161–163,241–246`); `store.ts:94–95,134–149` verifies and
persists that exact core. Never append reread metadata after sealing.

Add `statement` to `EXPORT_SOURCE_GRAINS` (`export/schema.ts:39–42`) and the
Content CHECK (`121_export.sql:47–50`) if Statement inputs are members. Keep
the `claim` grain for external source assertions used by
`export/vndb-source.ts:36–51`. Do not create `rezics-verification-v2`, a second
export operation or a reader for both old and new verification manifests.
Old dev exports are rebuilt as part of the authorized cutover.

## Bounded session specifications

The names below describe capabilities, not new task IDs. Each proving file is
run explicitly through `bun scripts/goal/goalctl.ts test <files>` by its worker.
Every item has **Mechanisms: none**. “IDs” means the proofs preserved or supplied,
not an assertion that those IDs are currently red or will be green after one
file passes. Only preparation items are independently landable.

### 1. B — Relocate durable analysis proofs (preparation)

Files/lines: `model/tests/claim-analysis.test.ts:127–223,236–249`, new
`services/main/tests/verification-analysis.test.ts`, and
`scripts/qa/coverage/fact.ts:9–19`. Move the origin, copying/AI, scope,
withdrawal, freshness and opaque-Statement-evidence assertions unchanged to
the verification owner. Leave Claim artifact/admission tests for retirement.
Update the exact file/name coverage references in the same commit.

Proof: moved owner file, remaining model file and
`scripts/qa/hidden-id-equality.test.ts` only if its inventory is changed.
IDs: preserve FACT01–04 analysis obligations; no new end-to-end green ID.
Native image: no. Content migration: no. Mechanisms: none.

### 2. B — Prepare exact Statement fixtures (preparation)

Files/lines: add a capability-named fixture under
`tests/qa/integration/fixtures/`; use `statement/graph.ts:recordStatement`,
`routes/contexts.ts:732–818`, existing qualification-definition helpers in
`tests/qa/integration/statement-qualification.test.ts`, and existing platform
grant helpers. Prove a personal and Realm Statement, qualified and unqualified,
with the real admission/read owner. Return Statement ID/revision, speaker,
definition/context pins and caller authority. Do not create Claim data, a fold
root, an arbitrary datePublished surrogate or a fake terminal receipt.

Proof: a small fixture conformance integration file using ordinary Statement
creation/read, plus `tests/qa/integration/statement-qualification.test.ts` when
its helpers change. IDs: Statement setup prerequisite; no FACT green claim.
Native image: no; current Statement profile already supports these inputs.
Content migration: no. Mechanisms: none.

### 3. B — Factor the existing verifier without changing behavior (preparation)

Files/lines: `verification/operations.ts:220–310,614–777,779–895`,
`assessment-producer.ts:1–45`, `graph.ts:607–643`. Separate exact owner input
loading from analysis, producer staging and effect reconciliation inside the
same verification owner. Preserve the existing entry points, digest inputs,
receipts, historical custody and outputs for this commit. Extract functions
only where the subsequent Statement entry path needs them; no plug-in loader,
second verifier, new ledger or additional decision strategy.

Split this preparation into three commits/sessions if needed: basis/analysis;
admission/producer staging; effect reconciliation/history. Prove each with
`services/main/tests/verification-lineage-bounds.test.ts`,
`tests/qa/integration/verification-assessment-producer.test.ts`, and
`tests/qa/integration/assessment-history-native.test.ts`, respectively.
IDs: preserve FACT01–04,06. Native image: no. Content migration: no.
Mechanisms: none. Stop this extraction if it would add a second mechanism for
a decision the current owner already makes; do the local port in the cutover.

### 4. B — Statement-only graph basis and assessment pins (cutover batch)

Files/lines: `verification/graph.ts:225–480,588–645,668,767–879,890–978`,
`operations.ts:148–158,178–289`, `analysis.ts:25,48–95,139–168`, and
`statement/read.ts:75–96`. Remove `CreateClaimInput`, normalization/digest/write,
ClaimRecord and both legacy/folded reads. Reuse the Statement read/snapshot
owner and exact head queries; the verifier carries case pins and an analysis
scope, not another proposition record. Convert graph evidence references to
exact Statement revisions. Preserve opaque evidence's failure to establish
independent corroboration. Require Statement membership and exact revision in
assessment writes, original-native decoding and DecisionSlot acceptance.
Remove the Claim-vs-Statement fallback in `readAcceptance` at `graph.ts:933–949`.

Proof: relocated verification analysis tests, new exact Statement basis owner
tests, `services/main/tests/verification-lineage-bounds.test.ts`, and the
Statement fixture. Cover absent/erased/ambiguous revision, withdrawn lifecycle,
wrong Statement, optional qualification, stale head and exact decision target.
IDs: FACT01–04 prerequisite. Native image: no **for the code batch alone**;
the model/native retirement in batch 12 is required before completed cutover.
Content migration: coupled to batch 5. Mechanisms: none.

### 5. B — One Content schema rename, split implementation review (cutover batch)

Files/lines: new `services/content/migrations/1790_claim_to_statement.sql`;
`verification/schema.ts:24,44–45,88–153,228–274`;
`store.ts:85–225,297–365,519–905,1213–1298,1476–1778,1838–1968`;
`assessment-producer.ts:12–43`; and all SQL-building owner fixtures identified
below. Reserve **content:1790**, to be renumbered at dispatch/merge. Do not
reuse or edit historical migrations. See the exact DDL inventory below.

Three session-sized reviews contribute to this single migration: evidence and
challenges; producer intent/walk/summary/dependency guards; subscription/export
grain and final installed-catalog comparison. SQL strings/types/fixtures must
follow the renamed columns in the same assembled cutover. Do not create old
column views, duplicate columns, dual-write triggers or two migrations that
pretend old callers survive a destructive rename.

Proof: `services/main/tests/verification-schema.integration.test.ts:131,169`,
`services/main/tests/verification-challenge-counts.test.ts`,
`tests/qa/integration/verification-challenge-counts.test.ts`,
`tests/qa/integration/verification-lineage-bounds.test.ts`,
`tests/qa/integration/verification-summary-pending-bounds.test.ts`, and
`tests/qa/integration/evidence-source-erasure.test.ts`, one file per QA run.
Require fresh install, upgrade, cross-revision rejection, concurrent head CAS,
producer immutability, rollback and erasure-aware guards. IDs: FACT01,03,04,06
prerequisites. Native image: no. Content migration: yes. Mechanisms: none.

### 6. B — Admitted Statement assessment and recovery (cutover batch)

Files/lines: `verification/operations.ts:188–310,311–389,446–613,614–933`,
`assessment-producer.ts`, `outbox-event.ts:6–10,61–73`,
`receipt-family.ts:3–5`. Delete claim creation admission/results/events and
`legacyClaimDispatch`. Rename live verification pins/intents to Statement,
preserving receipt identities, continuation exclusion from digest, challenge
authority, producer-before-dispatch custody and exact terminal replay. Keep
human review, analysis-partial and refused/stale activation outcomes separate.
Statement changes must reach freshness/invalidation with kind `statement`;
`graphHeads` and `currentVerificationHead` must agree with Content CHECKs.

Split admission/staging and reconciliation/history into separate sessions,
using the same owner functions. Proof: `verification-assessment-producer.test.ts`,
`assessment-history-native.test.ts`, `verification-invalidation.test.ts`,
`services/main/tests/assessment-history.test.ts` and the lineage owner file.
Preserve the assertions about missing originals and lost acknowledgements;
do not recreate original custody by reading a newer head.
IDs: FACT01–04,06. Native image: no alone; requires batch 12's target admission
profile at cutover. Content migration: batch 5. Mechanisms: none.

### 7. B — Evidence/challenge routes and disclosure (cutover batch)

Files/lines: `routes/claims.ts:201–266,340–345`, new
`routes/statement-verification.ts`; `services/main/tests/evidence-source-erasure.test.ts:24,42`,
`services/main/tests/verification-lineage-bounds.test.ts:246`; and new
`tests/qa/integration/verification-statement-case.test.ts`.
Move evidence reads/writes, challenge reads/submission/withdrawal with Statement
pins and target body schemas. Use the existing Statement disclosure/read owner
before returning case data or allowing a write. Preserve private observation
selector ownership. Hidden and absent parents answer identically for *all*
subresource paths, including lists and corrections; checking only evidence
authors does not establish parent disclosure.

Proof: new route integration and the two owner files. Cover wrong revision,
wrong parent, missing scope/grant, stale evidence head, retry conflict,
withdrawal ownership, hidden/absent parity and denial before Content writes.
IDs: FACT03 and route prerequisites for FACT01,02,06. Native image: no.
Content migration: batch 5. Mechanisms: none.

### 8. B — Quality, correction delivery and route registration (cutover batch)

Files/lines: `routes/claims.ts:15–31,109–200,267–335`,
`routes/statement-verification.ts`, `verification/operations.ts:899–933`,
`correction-delivery.ts:28–34,72–84`, `store.ts:1826–1939`,
`app.ts:24,180`, `scripts/qa/cases/backend-operations.ts:1382–1435`,
`scripts/static/hidden-id-reads.json:338–375,2785–2816`.
Finish assessment routes and the case-quality read; move corrections and
subscriptions. Notifications reference the Statement ID; preserve event
deduplication, leased cursors and recipient-specific rendering. Keep existing
Notification topic/display identifiers unless its owner separately changes
them. Register one import and `.use()` for the claimed target route module;
retain the non-Claim verification routes in a capability-named module.
Retire all eleven Claim method/path operations and classify the moved hidden
ID reads rather than copying `unregistered` as evidence of disclosure safety.

Proof: new Statement-case integration; ported `claim-template.test.ts:25,266`
including paid-challenger/correction assertions; `services/main/tests/g-543-rate-limit.test.ts`;
`scripts/qa/hidden-id-equality.test.ts`, `scripts/static/mechanism-writers.test.ts`
and `scripts/static/mechanism-dependencies.test.ts` when their inventories change.
IDs: FACT03,04,06; FACT01/02 integrated prerequisite. Native image: no.
Content migration: batch 5. Mechanisms: none.

### 9. A prerequisite — Public assessment export and reread (cutover batch)

Files/lines: `export/readers.ts:493–527`, `operations.ts:113–143`,
`schema.ts:39–42`, `planner.ts:80–91,161–163,241–246`,
`store.ts:94–95,134–149`,
`export/README.md:30–33,70–71`, `routes/exports.ts:34–46`, and
`tests/qa/integration/export-verification.test.ts:25,62–104,121–150`.
Implement the exact bundle above in the existing export contract and update
the reread locator at the same time. Port setup to Statement fixtures. Preserve
qualification, source provenance, calibration limits, actor/position checks,
rights and current disclosure. Recompute loss paths/ordinals for the actual
bundle; the current reader uses `memberOrdinal: 2` at `:520–524`, which cannot
be carried over mechanically to a new member layout.

Proof: export-verification file; extend its GET and outsider assertions to
qualifications, challenges, erased/withdrawn/private evidence, stale positions
and uncalibrated method output. Prove that locator tampering invalidates the
seal and that stale rereads do not select a newer input. Run
`services/main/tests/export-scoped.test.ts`
if planner validation changes. IDs: FACT05. Native image: no. Content migration:
batch 5 includes the `statement` grain if needed. Mechanisms: none.
Do not expand this session into rewriting the other export profiles.

### 10. A prerequisite — Port recovery and hidden-parent fixtures (cutover batch)

Files/lines: `tests/qa/integration/erasure-source-reconcile.test.ts:160,238–264,296,346`,
`hidden-id-equality.test.ts:139–152,215–224`,
`assessment-history-native.test.ts:89–120,142–162`,
`tests/qa/fault-recovery/owner-restore-erasure-fixture.ts` at verification store
setup, and `scripts/qa/serialization-points.ts` at the verification store entry.
Use actual Statements and moved operations; keep source erasure, restored
custody, original-native ambiguity, hidden-parent parity and historical reads.
Do not delete a recovery assertion merely because its fixture says Claim.

Split erasure/restore and history/disclosure into two sessions. Proof: each
changed file alone through goalctl; the owner restore fixture's existing fault
test is manager-owned outside these sessions unless the claim is expanded.
IDs: FACT03–05 dependencies plus the existing erasure/recovery families, whose
run-9 status was not available. Native image: no alone; final image required.
Content migration: batch 5. Mechanisms: none.

### 11. B — Remove retained-Claim Statement adapters (cutover batch)

Files/lines: `statement/graph.ts:13–23,127–159,284,367–411`,
`schema.ts:5,72,86,107,159,181–189`,
`qualification.ts:104–120,207–230,347–366,395–423,585–619`,
`projection.ts:7,117–119`, `read.ts:23,120–135,231–232,345–354`.
Delete retained domains/provenance/read validation and date-only conversion,
while preserving ordinary qualification, datePublished definition semantics,
Statement keys, speaker, lifecycle, evidence and classification conversion.
The public predicate read no longer needs an ASK for `retainedClaimHead`
(`qualification.ts:585–593`). No seek change is currently established.

Proof: `services/main/tests/statement-qualification.test.ts`,
`statement-projection.test.ts`, `statement-first-publication-date.test.ts`,
`statement-seek.test.ts`, plus `tests/qa/integration/statement-qualification.test.ts`
and `statement-provenance.test.ts`. Delete only fold-specific expectations.
IDs: structural Claim retirement; preserve ordinary Statement acceptance.
Native image: batch 12 changes the authored profile. Content migration: no new
migration. Mechanisms: none. Split graph/schema and qualification/read into
two sessions; do not split away the corresponding type callers.

### 12. B / A prerequisite — Authored model, generated contracts and native image

Files/lines: delete `model/definitions/claim-v1.ts/.ttl`; change
`statement-v1.ttl:15–24,46,80–89`; replace Claim alternatives in
`assessment-v1.ttl:48–52,75–94` and its canonical declaration at
`assessment-v1.ts:9`; port remaining `claim-analysis.test.ts:18–103,225–293`
and `model/tests/statement-qualification.test.ts:108,117–122`;
`services/main/tests/erasure-revision-kinds.test.ts:132`.

The worker protocol requires a new profile revision for tightened constraints.
Removing the Claim alternative tightens assessment admission. Default to a
sole replacement `assessment-v2.ts/.ttl`, with Statement-only assessment
anchors and unchanged source reliability semantics, and retire the old authored
assessment profile at final cutover. Update `graph.ts:13,114,127,617` and exact
model/shape pins/tests together. This is **not** a versioned export twin.
Alternatively the manager can explicitly override that revision requirement
for undeployed artifacts; simply editing v1 in place without noting the
conflict is not a complete specification. Do not rename `rv:ClaimAssessment`
merely for spelling: it is an assessment anchor, not an rv:Claim proposition.

Run `task gen` only after assembled route/module/model changes. Inspect
`packages/model/src/generated/{profiles,schemas,vocabulary}.ts`, generated
model shapes/contexts and `generated/openapi/main/public.json`; also inspect
the platform contracts because moved verification routes are platform-gated.
Generation owns `infra/jena/command-module/src/main/java/com/rezics/jena/RevisionClasses.java:13,80`
via `model/compiler/generate.ts:195–204` and `revision-classes.ts:5–12`.
ClaimRevision disappears only after *all* authored TTL references disappear.

Proof: remaining model/admission/qualification tests, relocated analysis file,
erasure revision-kind owner test, `task main:typecheck`, `task web:typecheck`,
`task gen:check`, `task docs:check`; native Maven tests/image build. The existing
Task-backed builder is `task toolchain:install` (`scripts/dev/cli.ts:314–326`),
which also checks/downloads other toolchain components. A dedicated
`task fuseki:build` does not exist. `task release:images` only inspects the
already-built Fuseki image (`scripts/ops/release-images.ts:342–348`); its success
does not prove the native build. Use the manager's existing approved native
build path or the local Task-backed builder, and retain its actual Maven log.
The tag is computed from build inputs; report the actual resulting tag and
Maven success line, not a guessed suffix. Native image: **yes**. Content
migration: only batch 5. Mechanisms: none.

Split model/admission and generated/native validation into two sessions, with
the manager retaining the unlanded assembled cutover. Pin owners are
`infra/dev/compose.yaml:37`, `scripts/dev/release-manifest.ts:16,21`, and
`docs/development/toolchain.md:384`. Coordinate pin commits with other native
work. Restore uncommitted generated trees as the worker protocol requires;
generated Java and authored pins need explicit claims. Image-build duration
is a separate budget: `scripts/dev/refresh-stack.ts:123–128` records an earlier
1090-second cold build and a 45-minute ceiling, so no sub-ten-minute cold-build
or one-session wall-time guarantee is established here.

## Exact Content migration inventory

One forward `1790_claim_to_statement.sql` covers all of the following. The
number is a reservation, not proof of current availability on the manager's
merge head; dispatch/merge renumbers it. Dev/fixture Claims and old verification
exports are rebuilt; **no Claim-to-Statement data conversion is specified**.
If retained producer/summary rows are present, stop and rebuild the disposable
data first: column renaming does not make their old proposition pins or intent
digests valid Statements.

| Current DDL | Required change |
| --- | --- |
| `091_verification_evidence.sql:7–8,58` | Rename `claim`/`claim_revision` in evidence revisions and `claim` in heads to `statement`/`statement_revision`. |
| `091:9,18–25,60,66–104` | Replace `claim-head` purpose/default/head-purpose consistently in CHECKs, chain indexes, FKs, guards and head activation. |
| `092_verification_challenge.sql:7–8,48,57,63` | Rename challenge, pending and head columns; replace Claim-named row fields in challenge-open guard. |
| `093_verification_summary.sql:12–13`; `094_verification_freshness.sql:49,58` | Rename summary proposition/revision pins; update evidence/challenge freshness trigger bodies. |
| `096_verification_correction_delivery.sql:12,27` | Rename subscription revision/head key; keep recipient/CAS/cursor behavior. |
| `1520_verification_walk.sql:24,38,77–82` | Rename walk key; replace dependency kind `claim` with `statement` in the latest `summary_dependency` and `invalidation` CHECKs, preserving every other admitted kind. `active_dependency.kind` has no CHECK; update its stored/input kinds without inventing a constraint to drop. |
| `1522_verification_challenge_counts.sql:29,38,62` | Replace the latest resolution/count-retirement function bodies, not their obsolete 092 definitions. |
| `1704_verification_assessment_producer.sql:23–34,48,64–68` | Rename pins; change intent JSON admitted keys/equality to `statementRevision`; replace NEW/OLD immutability comparisons. Preserve all custody/generation/restore constraints. |
| `121_export.sql:47–50` | Add Statement grain if used; retain external `claim` and all other current grains. |

The full migration filenames should be rediscovered at dispatch; line anchors
above identify the numbered definitions, not authority to edit those files.
Column renames do not rewrite PL/pgSQL source. Preserve the erasure-aware
evidence-item guard installed by `1709` at `:133–136`, and pending-dependency
indexing from `1703:3`. `090_verification_lineage.sql:54–87` already uses
generic output/input references; it does not need a Claim-specific key rename.

## Inventory disposition and claims to widen

The original inventory pattern was reproduced read-only across `services`,
`scripts`, `tests`, `apps`, `packages`, `model`, `docs` and `generated`, excluding
dependencies. Broader searches for `claimRevision`, verifier imports and direct
SQL found additional consumers the pattern misses. Goal task/report prose is
decision/history evidence, not a product client and not a reason to rewrite
past reports.

| Disposition | Files / starting evidence |
| --- | --- |
| Delete | `claim-v1.ts/.ttl`; Claim writer and dual ClaimRecord reader in `verification/graph.ts:225–480`; creation view/options in `operations.ts:59,134–158`; Claim route declarations/handlers; creation event/family; retained helpers in Statement files named in batch 11. |
| Port | All nine verification subresource operations, quality read, assessment graph/producer/recovery, evidence/challenge/summary/subscription SQL and types; export reader/rereader and grain; backend operation map and hidden-ID map. |
| Port owner tests | `services/main/tests/{evidence-source-erasure,g-543-rate-limit,verification-lineage-bounds,verification-challenge-counts,verification-schema.integration,erasure-revision-kinds}.test.ts`; owner Statement tests named in batch 11; history tests when exact pins change. |
| Port integration tests | `tests/qa/integration/{claim-template,export-verification,assessment-history-native,erasure-source-reconcile,hidden-id-equality,verification-assessment-producer,verification-challenge-counts,verification-invalidation,verification-lineage-bounds,verification-summary-pending-bounds,evidence-source-erasure}.test.ts`. Most store-only tests currently use synthetic IRIs; keep their bounded/concurrent/recovery assertions while renaming pins and physical SQL. |
| Port registry/fixture callers | `scripts/qa/coverage/{fact,fact-invalidation,fact-export}.ts` when file/name changes; `scripts/qa/serialization-points.ts`; `tests/qa/fault-recovery/owner-restore-erasure-fixture.ts`; `scripts/static/mechanism-dependencies.json` only if a renamed entry path requires it. |
| Generate / inspect | Model profiles/schemas/vocabulary/shapes/contexts, public **and platform** OpenAPI, Java RevisionClasses, image/release/toolchain pins. Generated files are not independent authored fixes. |
| Keep | `model/definitions/work-address-claim-v1.*`, compiler/address/space/zone/collection tests that match that substring, `tests/qa/integration/validation-cross-profile.test.ts:123`, source extraction claims, graph-query `claims`, unrelated address/safety/account claims, external export claim grain, immutable historical task/report text. |
| Keep behavior, relocate proof | `model/tests/claim-analysis.test.ts` behavioral portions; all assertions about lineage bounds, independent resolution, stale activation, erasure, original custody, rate limits, calibration, public disclosure and funding neutrality. |

Necessary expansion beyond G-1618's old paths includes `app.ts`, the actual
Statement route/read/projection owners, new verification route/fixture/owner
test paths, assessment definitions (or their sole replacement revision), QA
coverage files, schema/challenge/erasure-revision owner tests, added integration
ports, restore fixture, Java generation output and Web OAuth scope cleanup.
The manager must check each owner before dispatch. This report itself makes
no owner-code change and does not claim these paths are currently unclaimed.

## Acceptance and finish-line evidence

`scripts/qa/cases/information-verification.ts:6–33` defines FACT01–06. Its
prospective scenarios at `:37–65` explicitly do not enlarge the qualified
denominator. No numeric CLAIM or VERIFY family was found in the current case
catalog. Do not invent those IDs or interpret capability names as acceptance.

| ID | Proof that must survive / turn green after the assembled change |
| --- | --- |
| FACT01 | Origin deduplication; unknown/circular/over-budget abstention. Registered at `scripts/qa/coverage/fact.ts:9`; relocated analysis plus ported owner journey. |
| FACT02 | Copied sites and AI re-ingestion create no independent origin. `fact.ts:13`; relocated analysis plus ported owner journey. |
| FACT03 | Scope, later edition, counterevidence, support withdrawal and independent resolution stay distinct. `fact.ts:17`; analysis and full Statement verification journey. |
| FACT04 | Exact history, bounded invalidation and stale-generation CAS. `coverage/fact-invalidation.ts:4`; owner journey and `verification-invalidation.test.ts:8`, with producer/history bounds also passing. |
| FACT05 | Exact Statement bundle, method/policy/provenance, disclosure losses and GET reread. `coverage/fact-export.ts:4`; `export-verification.test.ts:25`. |
| FACT06 | Payment neither changes verdict nor suppresses correction. `coverage/fact-export.ts:6`; ported journey's funded challenger section at `claim-template.test.ts:266`. |

The new `verification-statement-case.test.ts` must use the public application
and real stack: create a Statement; append/read evidence; assess/read exact
assessment; submit/list/withdraw a challenge; read corrections; subscribe;
export/reread the Statement bundle; compare hidden with absent parents. Also
assert retired Claim operations are absent and all six unrelated verification
operations remain registered. Register the new proofs in coverage; existence
of a new file alone does not qualify any ID. Preserve the larger owner journey
instead of replacing it with a happy-path smoke test.

At assembled landing, workers report explicit goalctl QA run IDs for every
ported file, relevant owner proofs, main/web typecheck, generated/docs checks,
changed-directory oxlint and changed-file ast-grep. Preview affected tests with
`bun scripts/goal/goalctl.ts test --affected --list`; list outside-claim files
for manager/program regression instead of running whole tiers. Separate
non-test source and test diff statistics against the manager's integration
base. Expected source decrease comes from removal of Claim writes, union
reads, retained adapters and route halves; test growth may be justified by
new Statement/disclosure/upgrade proof. No estimated diff is a measured result.

## Unestablished facts and manager action

- **Run-9 results unavailable:** `.temp/goal-program/run9-acceptance.json` and
  its containing directory are absent here. The user requires translating
  cited main-checkout paths into this worktree. Other reports' observations
  of main-checkout artifacts cannot establish this session's run-9 status.
  No ID has been reproduced, declared fixed or turned green by this analysis.
- **No live client observation:** static absence of direct Claim-route calls
  does not prove absence of outside clients. Launch typechecking is required;
  a runtime `/v1/claims` dependency was not found. Do not gratuitously break
  its already-Statement graph-query response to satisfy an expected narrative.
- **No execution proof:** SQL upgrade, native image/Maven success, export
  rights equivalence, rendered UI behavior and one-session runtime estimates
  were not tested. This brief requests read-only reproduction and no QA.
- **Profile revision decision:** assessment admission tightening needs the
  sole replacement revision or an explicit undeployed-profile exception;
  changing only claim-v1 is incomplete. This is a model contract issue, not
  an invitation to add an export version or provider identity prerequisite.
- **Independent-green constraint:** bounded cutover batches are specified,
  but they are not independent green landings. The manager should retain
  their integration branch until model, native image, routes, SQL, export,
  generated contracts and all ported proofs agree. Strict one-session green
  landings for every batch remain unestablished under the no-compatibility
  constraint.

Dispatch preparation first. Widen claims and resolve the assessment revision
before the cutover batches. Assemble and build the image before switching any
shared fixture generation; rebuild disposable Claim-era data using the
existing fixture owner, then run each ported proof. Land the coordinated
cutover only after the complete affected contract is green. Class C work—URL
aliases, fold restoration, broad receipt/topic renaming, unrelated claim
vocabulary cleanup and a renamed graph-query collection—is cut from this plan.
