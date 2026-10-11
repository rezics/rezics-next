# Owner recovery, relay fixtures and Content projection liveness

Read-only investigation on `0f4a8a726`, 2026-10-11. This report is the only
authored change. Product code and tests were not changed. Line numbers refer to
this checkout; implementation must relocate them after the manager rebases.

The regression artifact paths in the brief are absent from this worktree. Their
original copies under the main checkout were inspected read-only. Reproductions
used this worktree and `bun scripts/goal/goalctl.ts test <file>` with one selected
file per invocation. No native image was built and no developer server started.
The initial delegated invocations overlapped in admission; subsequent calls were
serialized. Each reproduction selected just its named file, not a whole tier.

“Turns green” below means the named failing case's contribution to its acceptance
IDs. An isolated pass is not qualification of an entire ID. A means incomplete
or wrong behavior, including a qualification function missing its prerequisites;
B means work that can follow opening; C means defer. Already repaired cases are
listed separately and require no replacement implementation.

## Reproduction ledger and one-line causes

| File, relative to repository root | IDs | Alone outcome / QA run | Cause and introducing commit |
| --- | --- | --- | --- |
| `tests/qa/fault-recovery/coordinated-owner-cut.test.ts` | OPS03, PKG14, SYS12 | FAIL, `20261011t085712-65e81c` | `c53d3effc` / `e284edeae` made retained-erasure release and separate captured relay prerequisites; this older fixture reaches that gate before its expected Account WAL mismatch. |
| `tests/qa/integration/owner-outbox-recovery.test.ts` | SYS04, SYS12 | PASS, `20261011t085921-bab160` | `d27907918` changed Main relay to stream-scoped high water; the fixture omitted it. Already repaired by `76c781367`. |
| `tests/qa/integration/relay-retained-snapshot.test.ts` | OPS03, SYS12 | FAIL, `20261011t085959-b66377` | `d27907918` requires a relay position or its legacy `event.data.sourcePosition` fallback; synthetic envelopes introduced by `c697c989e` omit both. |
| `tests/qa/fault-recovery/event-time.test.ts` | RATE09 | FAIL, `20261011t085723-d96785` | `05a9f8831` requires `eventTemporalAccess` for publication; the fault fixture did not receive the Access binding added to the integration fixture. |
| `tests/qa/fault-recovery/work-derivation-recovery.test.ts` | OPS03, WORK04 | PASS, `20261011t085719-28e899` | `d27907918` added `stream_scope` to the checkpoint SELECT, defeating the SQL-prefix fault injector from `9b35442ad`; already repaired by `0a0188e05`. |
| `tests/qa/fault-recovery/erasure-campaign-qualification.test.ts` | OPS10 | FAIL, `20261011t085735-360d5c` | `a75a10c8f` added a retained-small-backup consumer, while preparation from `2b874a523` recognizes only the launch drill; the consumer's isolated checkout has no compatible small backup. |

Invocation logs are `.temp/coordinated-owner-cut-alone.log`,
`.temp/owner-outbox-recovery-alone.log`, `.temp/relay-retained-snapshot-alone.log`,
`.temp/goal-analysis/event-time.log`, `.temp/work-derivation-recovery-alone.log`
and `.temp/erasure-campaign-qualification-alone.log`. QA summaries and failure
stacks are in `.artifacts/qa/<run>/summary.md` and `logs/<tier>-f1.log` (integration
uses its corresponding shard log). These temporary artifacts are not committed.

## 1. Restore mismatch probes must reach the owner they test

**A: the recovery qualification function is incomplete under the current owner
contract.** Its mismatch tests do not exercise the owners named in their titles.
Do this first, in one Luna/max session; do not weaken production recovery gates.
`work/restore-lineage.ts:621` checks the retained-erasure callback before the WAL
frontier at `:715`; `:626-640` requires an independently captured relay, introduced
by `f0fd09420`. This explains why changing only the expected message is insufficient.

Files and change:

- `tests/qa/fault-recovery/coordinated-owner-cut.test.ts:419-422`: test the
  Account WAL mismatch using the existing `assertPgRecoveryFrontier` primitive
  and the captured `coverage.accountPg`, expecting `PgRecoveryFrontierConflict`
  while proving the graph/Access holds
  remain closed. This is before a physical captured relay copy exists. Calling
  the complete release with the current journal as its own captured copy does
  not isolate the WAL fault.
- Same file `:507-509`: supply `restoredRelayPool: restoredRelay` in
  `restoredEvidence`, and a `releaseErasures` callback that fails if called.
  These are denial probes, so none may reach release. Pass the independent
  retained source `relayPool` as the journal to every primitive release probe
  at `:539-697`; keep `restoredRelay` as the captured, mutable physical copy.
- Same file `:646-661`: the removed captured batch must fail with the current
  captured-handoff diagnostic (`captured relay handoff is unavailable`). Preserve
  the mutation, restoration and refusal assertions; do not replace the probe
  with a catch-all rejection assertion. Carry `stream_scope` when saving,
  deleting and reinserting relay rows so the fault affects only the Main stream.

Proof: the existing coordinated-owner-cut file must pass each denied/mismatched
probe before reaching its final successful-release section. Verify the fail-if-
called callback was never invoked and both holds remain closed at every denied
probe. No new file is needed. The API/full-success section belongs to item 2;
this step alone does not turn the whole file green.

Turns green: mismatch subcases of OPS03/PKG14/SYS12; final acceptance depends on
item 2. **Mechanisms: none; reuse existing owner frontier and release checks.**
**Native image build: no.**

## 2. Complete the coordinated restore fixture with retained erasure authority

**A: the successful restore qualification omits required retained authority and
confuses the journal with its captured copy.** One Luna/max session after item 1.

Files and change:

- `tests/qa/fault-recovery/coordinated-owner-cut.test.ts:404`: retain erasure
  coverage with the existing `retainErasureCoverage(relayPool, consumer)` next
  to the retained recovery coverage. Obtain the retained sealed authority from
  that helper, not from a newly invented empty deletion set.
- Same file `:510-512`: construct `OwnerOperations` on the retained `relayPool`;
  put `restoredRelayPool: restoredRelay` in its restore resources. Configure its
  existing `erasures` resource with retained `authority: { sealedCoverage,
  hmacKey }`, the project's `FUSEKI_TITLE_ADMISSION_KEY` as signing key,
  `heldErasureMaintenanceClient` using the isolated project's URL/maintenance
  token, and `originalSource: 'retained-native-event'`.
- Reuse the setup demonstrated by
  `tests/qa/fault-recovery/owner-restore-erasure-fixture.ts:836-857` and the separate
  journal/captured relay pattern in
  `tests/qa/fault-recovery/restore-hold-seam.test.ts:187-195`. These files are
  references to existing owner behavior, not additional edit claims.
- Same coordinated file `:710`: query reconciliation cuts in the retained
  `relayPool`, where `OwnerOperations` writes them. At `:715`, replace the
  duplicate explicit Access release with assertions that the configured release
  already opened restored Access and graph, while source Access remains held.

Proof: existing coordinated-owner-cut test alone, including denied bearer,
extra deletion set, every reversible owner/object fault, final matched owner
cuts, idempotent replay and post-release Account/Content/package reads. Preserve
the existing physical backup verification and actor isolation. Add final fence
assertions in that file. No new test file is needed.

Turns green: OPS03/PKG14/SYS12 contributions from coordinated-owner-cut, contingent
on observing the previously unreachable final sections. **Mechanisms: none;
existing retained-erasure release owner only. Native image build: no.**

Trust-ops overlap: `erasure-restore`, `account-erasure-frontier`,
`sys-erasure-replay`, and `notification-erasure` also depend on retained-erasure
reconciliation. This specification does not prescribe edits to any of those
files or to their reconciliation implementation. If the configured existing
owner fails with valid retained evidence, hand that exact failure to trust-ops.

## 3. Retained relay page fixtures must contain a scoped source position

**A: synthetic fixtures no longer represent a valid retained event.** One
Luna/max session; repair the fixture, not the validator.

Files and change:

- `tests/qa/integration/relay-retained-snapshot.test.ts:18-32`: set
  `MAIN_RELAY_STREAM_SCOPE` explicitly on checkpoint, batches and delivered
  events. Each generated envelope must include legacy `data.sourcePosition`
  with `datasetId: 'product'`, `dataEpoch`, and decimal-string `sequence`, plus
  `data.routingEpoch: '1'`. Keep `relayPosition` absent to exercise the supported
  pre-stream fallback at `outbox/relay.ts:207-214`; assert the returned envelope
  has normalized `relayPosition` equal to Main scope/epoch/sequence. Keep batchId
  and ordinal; use the real scope constant rather than duplicating a guessed
  scope string.
- Same file `:33-59`: scope reads/mutations/cleanup to that stream. Preserve the
  1,001-row inventory and the assertion that a mutation before the page boundary
  invalidates a retained proof requested after the boundary.
- The cause is the position validator in
  `services/main/src/modules/outbox/relay.ts` added by `d27907918`. Do not allow
  a missing source position or catch its TypeError as successful coverage.

Proof: existing relay-retained-snapshot alone, retaining both earlier-page
corruption assertions. Add a cross-stream event/batch at the same epoch/sequence
and prove it neither changes Main coverage nor satisfies a missing Main batch.
No new test file is needed. A structured error for an envelope missing both
position representations is separate hardening, item 14; do not mix it into
this fixture repair.

Turns green: OPS03/SYS12 contributions from the retained page-boundary case.
**Mechanisms: none; existing stream-scoped relay. Native image build: no.**

## 4. Event recovery qualification needs the actual temporal projection

**A: the fault qualification fixture is incomplete.** One Luna/max session.

Files and change:

- `tests/qa/fault-recovery/event-time.test.ts:30-34`: clone the `relay` database
  as well as account/access, bind a relay pool, and type the environment as
  `WorkActivationEnvironment & { eventTemporalAccess: Pool }` with
  `eventTemporalAccess: access`. Keep the missing-owner refusal in production
  `services/main/src/modules/event/observation.ts:251` unchanged.
- Same test `:44-54`: instantiate `EventTemporalProjection(access, relay, env)`;
  initialize an isolated Main relay consumer and drain the Main outbox with a
  fixed iteration bound after publication. The first query creates a temporal
  window; tick the projection and query until `state === 'ready'`, with an
  explicit bounded-loop failure. Use the working fixture pattern in
  `tests/qa/integration/event-time.test.ts:53-77,197-214`. Do not cast an
  unavailable/partial query into a ready result.
- `services/main/src/modules/event/queries.ts:208-253` now returns partial or
  unavailable until the checkpoint, effects and window are covered (introduced
  by `16dd53d4f`, refined by `9017a2226`/`05a9f8831`). Merely supplying the pool
  would leave the file's later item assertion false. Warm before engaging the
  recovery hold; preserve held-read refusal. Delete the exact manifest only
  after obtaining a ready baseline. Keep the subsequent exact-byte restoration
  and stable sourcePosition assertions. Close the new relay pool in `finally`.
- The manifest error still originates from
  `verifyEventObservationManifest` at `observation.ts:345-351`; the query's
  page hydration calls it via `source.ts:297`. Retain the existing specific
  `EventObservationUnavailable` assertion rather than changing it speculatively.

Proof: existing fault-recovery/event-time alone plus the existing focused Event
unit file `services/main/tests/event-query-bounds.test.ts`. The fault file must
show ready baseline, denied recovery hold, missing manifest, exact repair and
unchanged observation receipt. No new test file is necessary.

Turns green: RATE09's Event recovery case. **Mechanisms: none; existing temporal
worker and Main relay. Native image build: no.** Only the initial missing-pool
exception was reproduced; later sections are static deductions until this
fixture is repaired and rerun.

## 5. Prepare the erasure qualification's existing small backup before shards

**A: QA preparation is missing for an explicit retained-backup consumer.** One
Luna/max session. There is an existing builder; do not build another.

Files and change:

- `scripts/qa/cli.ts:730-768`: extend the existing pre-shard small-fixture
  preparation branch to recognize an explicitly selected
  `tests/qa/fault-recovery/erasure-campaign-qualification.test.ts` using its
  default small profile. Reuse the existing `prepareFixture` command under the
  existing preparation/startup/work slots. Set `REZICS_FIXTURE_ROOT` and export
  its returned ID as `ERASURE_CAMPAIGN_FIXTURE` to erasure shards. If both launch
  and erasure need the same small fixture, build/prepare once and export to
  both; determine their needs independently so a supplied launch fixture does
  not suppress needed erasure preparation.
- Use this precise erasure auto-preparation predicate: selected erasure file,
  `(ERASURE_CAMPAIGN_PROFILE ?? 'small') === 'small'`, and undefined
  `ERASURE_CAMPAIGN_FIXTURE`, `ERASURE_CAMPAIGN_SOURCES` and
  `ERASURE_CAMPAIGN_COPY`. Empty malformed supplied values must go through
  their existing validation, not silently trigger automatic preparation.
- Preserve explicit `ERASURE_CAMPAIGN_FIXTURE`, medium qualification and supplied
  source/copy workflows; inspect the erasure test's inputs at `:80-122` when
  selecting the bypass. Fail before shard execution when preparation fails.
  Supplied sources still require their matching retained manifest at `:162-171`;
  bypassing automatic preparation does not bypass fixture compatibility.
  Do not build a fresh corpus within the campaign's measured operation clock.
- Leave `tests/qa/fault-recovery/erasure-campaign-qualification.test.ts:155-171`
  and its image/compatibility gates intact.

Proof: extend `tests/qa/unit/qa-harness.test.ts:324` with erasure-only selection,
joint selection preparing once, explicitly supplied fixture/source bypass,
medium bypass and preparation failure preventing shard execution. Existing
budget tests: `tests/qa/g-955-harness.test.ts:322` and
`tests/qa/unit/startup-work-budget.test.ts:64`. Then run the existing OPS10
qualification file alone. No new test file is needed.

Builder/cost evidence:

- `scripts/fixture/build.ts:36` already implements `buildFixture('small')`;
  `scripts/fixture/corpus.ts:21` defines 1,000 Works. Task entry point:
  `task fixture:build -- --profile small`; harness preparation uses the existing
  `--prepare` path in `scripts/fixture/prepare.ts:18`, with reuse/compatibility
  and a 600-second active preparation budget.
- Run 9 built `fx-small-f421246999d8`: builder active time **53,527 ms**,
  total preparation active time **75,782 ms**, admission wait **7,647 ms**.
  Evidence under the brief's original regression root:
  `qa/fault-recovery-2/attempt-1/20261010t235202-b77741/fault-recovery-fixture-preparation.json`
  and `logs/fault-recovery-fixture-preparation.log`.
- That build belonged to cached checkout `ffbb510d285652da`; the erasure
  campaign ran in `6b725fd0c5b81b80`. Checkout-local fixture roots prevented
  reuse. The main retained fixture manifests inspected now have medium
  100,000-Work and custom medium 22,004-Work backups, not a compatible small one.
  Existence in another checkout is not compatibility or availability here.

Turns green: OPS10's missing-backup prerequisite, then the actual campaign must
qualify. Historical cost is not a current timing guarantee; later campaign
outcomes and medium cost were not established. **Mechanisms: existing fixture
preparation; none new. Native image build: no change requires one; use the
repository's exact pinned image and retain the compatibility checks.**

## 6. Two run-9 failures are already repaired

**B: further cleanup can follow opening; the reported defects themselves are
resolved in this checkout.** No new implementation session or mechanism.

- `tests/qa/integration/owner-outbox-recovery.test.ts`: `76c781367` installs the
  Main stream high-water facts and scoped batch fields. The alone run passes;
  SYS04/SYS12 are partial passes in its QA summary. Keep the scoped empty-stream
  assertions. Native image build: no.
- `tests/qa/fault-recovery/work-derivation-recovery.test.ts:199-204`:
  `0a0188e05` uses returned checkpoint scope/epoch/sequence rather than the
  literal SQL SELECT prefix, scopes retained mutations and proves restored
  cursors at position 12. The alone run passes: one test, 64 expectations;
  OPS03/WORK04 contributions pass. Native image build: no.

Re-run these files in the manager's regression after composition. Do not create
a second patch for either original run-9 symptom.

## Deferred-forever class: evidence and chosen proposal

**A: production projection liveness is incomplete.** Cause in one line:
`67b343aa2` / `2099d4cb8` require Public-only eligibility, while `8e7740c9f`
retains every failed current text event and holds completed coverage behind its
oldest pending sequence; no negative terminal decision exists to release it.

The current terminal paths in `content-publication/relay.ts:294-304` are rejected
publication, Site publication and non-text recipe (`ignored`), or obsolete head
(`superseded`). They do not terminally acknowledge a current active text
publication excluded from public search. `graphPublication` reads only
`rv:disclosure rv:Public` at `:95-98`; `projectEvent` throws at `:312-313` whenever
that proof is absent. `eligibility.ts:28-38,79-84,326-342` and
`routes/content.ts:53-58,340-346` only admit and produce Public decisions.
“Decided private” is therefore not represented by this owner today. An authorized
private draft unit from `search-private-projection.ts:32-35,84-109` is a different
derivative and cannot stand in for exclusion authority.

The cursor unit is one Content outbox event, identified by epoch and sequence.
`projection-cursor.ts:46-52` admits exactly one next source position.
`acknowledge` at `:83-85` keeps completed `sequence` at
`min(pending.sequence) - 1`, while advancing `scan_sequence`. `retries` at
`:101-112` selects the oldest event of each of eight targets; later events for
that variant are retained at `relay.ts:403-410`. Once scan reaches the owner
head and retries remain unsuccessful, `relay.ts:367-396` returns idle with
pending rows intact. There is no pending-row bound in that cursor.

| Reader/gate | Lines | Effect of one unresolved current text publication |
| --- | --- | --- |
| Content phrase search and Content public readiness | `content-publication/search.ts:151-175,272-278,289-293` | Completed cursor must equal Content owner position; the whole read fails. |
| Main phrase search including Content | `work/search-public.ts:57-61,208-215` | Unrelated public phrase queries also lose readiness. |
| Service health and current search generation | `routes/health.ts:95-108`; `routes/search-generations.ts:35-41` | Readiness is 503 and generation unavailable. |
| Quarantined replay | `content-publication/rebuild.ts:703-720` | Cannot finish the Content cut. |
| Rebuild verification/activation | `rebuild.ts:878-881,1017` | Exact completed cut is required; activation cannot proceed. |
| Rebuild checkpoint adoption | `projection-cursor.ts:170-178` | Requires exact cut and no pending rows in either consumer. |
| Operational admission | `operations/backpressure.ts:77-86` | Completed lag eventually saturates the worker lane. |
| Load clone qualification | `scripts/load/clone-probe.ts:96-98` | Cannot qualify the clone at its owner head. |

Thus **one private active text publication can block production rebuild
activation**; this is a source-derived counterexample, not an executed fault
qualification. `11e45692b` introduced the exact-cut rebuild gate. Do not replace
completed coverage with scan position: it would certify unresolved data.

Erasure release itself does not directly wait on this cursor:
`modules/erasure/reconcile.ts:368-375,433-435` uses the retained recovery coverage
head and erasure-journal frontier. The search rebuild after erasure does wait on
it. The run-9 `erasure-search-rebuild` failure is **not yet attributed** to this
class: its `unpublishedBody` at `:210-219` is a saved draft, intentionally ignored
by this relay, not an active private publication. A retained pending-event dump
with event types, exact publication/eligibility proofs and both cursors at its
failing `:271-274` would settle that attribution. Trust-ops owns its retained-
erasure reconciliation; no changes to those files are specified here.

The proposed contract is **excluded from public search until an exact explicit
approval**. Every successful publication gets a durable default exclusion from
the existing eligibility owner, atomically with publication. It grants no read
visibility and asserts no copyright assessment. Absence or corruption is still
unresolved. Use the one existing eligibility head for both exclusion and
approval, with exact publication binding. Legacy current publications receive
the same decision through bounded owner reconciliation with CAS.

This default is a proposed contract, not a policy already established by the
code. The manager must adopt it before dispatching items 7-12. An alternative
that only adds an explicit private operation does not cover ordinary private
publications; continuing endless retries preserves fail-closed reads but leaves
the confirmed liveness failure. A timeout/attempt-count skip has no authorization
proof. A second policy registry or a relay-authored privacy decision would
duplicate the eligibility owner and must not be built.

Later Public approval needs durable projection work of its own. The graph emits
`ContentSearchEligibilityEvent` at `eligibility.ts:337-342`, mapped by
`outbox/relay.ts:530-534`, but current consumers do not reproject body text after
the original Content event completes. `work/serial-projection.ts:320-328` updates
serial facts, not body projection. Items 9 and 10 are therefore a single release
milestone: never enable terminal exclusion without the later-approval recovery
path. Items 7-12 and 15-16 are separate Luna/max-sized sessions with explicit prerequisites.

## 7. Give the existing eligibility owner an exact exclusion proof

**A prerequisite.** One Luna/max session, after manager adoption of the contract.

Files/lines: `eligibility.ts:28-38,74-84,310-363`;
`model/definitions/content-search-eligibility-v1.ttl:15-16`;
`model/compiler/generate.ts:24-78` and `model/compiler/registry.ts` (existing
declaration discovery/canonical routing, not another hand-written profile list); native
`infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:1416-1482`.
New files: `model/definitions/content-search-eligibility-v3.ttl` and matching
`.ts` declaration;
`services/main/src/modules/content-publication/exclusion.ts`.

Define a new authored exclusion profile for the existing eligibility capability,
with a new explicit term meaning `ExcludedFromPublicSearch` (a search disposition,
not a claim of private read visibility). Do not edit exact retained v1/v2 bytes
or fabricate OriginalContribution/PublicDomain rights for exclusion. Bind the
immutable decision to resource, variant, exact publication decision, original
publication-authority proof, graph lineage and deterministic owner receipt.
The existing eligibility head remains the one current owner decision. Positive
admission, rights and public-domain assessments retain their existing checks.
No new public endpoint is needed for default exclusion.

The native validator must recognize this profile and validate its distinct
authority path: narrowing public search is proven by the exact succeeded
publication receipt, not a synthesized `content:search-eligibility` admission.
Keep current-head/variant/resource/receipt CAS checks and native positive
rights/disclosure enforcement. Export owner helper functions to create the
default triples and verify an exact exclusion receipt; they must not decide
public approval. Profile loading and validation include this profile before
negative delivery can be enabled.

The native exclusion owner must also authorize exact variant-scoped cleanup of
prior public body MatchUnits. After verifying the current exclusion head and
publication, delete only that variant's stale public body units via the native
writer so the existing Lucene delta is committed too. A concurrent newer Public
approval fails the cleanup CAS and preserves its unit. Retain historic revision
anchors/receipts according to custody rules; cleanup is not graph erasure. This
belongs to the same eligibility owner, not a relay-authored policy. Its cleanup
delivery receipt binds source event, owner exclusion receipt, exact target and
rebuild identity; it records execution, not a second decision.

Proof: new `services/main/tests/content-exclusion.test.ts`, extend existing
`services/main/tests/content-eligibility.test.ts`,
`model/tests/search-projection-turtle.test.ts`; new native file
`infra/jena/command-module/src/test/java/com/rezics/jena/ContentSearchExclusionTest.java`.
Cases: wrong publication/resource/variant, unproved authority, stale
head, wrong lineage, restore hold, lost response/replay, conflicting digest,
negative proof cannot authorize a Public MatchUnit, and existing v1/v2 approval
remains valid. Generated profile/model files are regenerated, not committed.
Also prove exclusion removes an older Public unit from RDF/Lucene, affects no
other variant, and cannot delete a concurrently newer approved unit. Extend
`infra/jena/command-module/src/test/java/com/rezics/jena/SearchDeltaJournalTest.java`
for index cleanup. Cover `CommandService.java:1526-1536`: an exclusion decision
must never pass the existing Public projection eligibility check.

IDs: prerequisite for SEARCH08/SEARCH20/OPS10 recovery coverage; no independent
green claim. **Mechanisms: Content search exclusion is an exact decision of the
existing eligibility owner; absence is unresolved. Native image build: yes**
(new authored profile and native validation). No tool is added or replaced.

## 8. Default exclusion on publication and bounded legacy reconciliation

**A.** One Luna/max session after item 7.

Publication's new default head changes approval CAS input. Item 15 exposes it
and migrates the real Studio caller; item 16 migrates remaining fixtures. Treat
items 8/15/16 as one contract activation milestone.

Files/lines: `content-publication/publish.ts:176-228`, existing helper from item 7,
`eligibility.ts:320-355`, `search.ts:77-117`,
`rebuild.ts:752-757,767-770,825-835`. New file:
`services/main/src/modules/content-publication/reconcile-exclusion.ts`.

Successful publication must atomically establish default exclusion for its new
exact head, using the owner helper and native validation. Do not carry an old
publication's Public approval onto new bytes. Deterministic default identity
derives from the immutable publication receipt. Replaying the publication must
not overwrite a later approval of that exact publication.

For existing current heads without exact eligibility, reconcile one keyset page
of at most 100 variants per call. Add a narrow owner reconciliation checkpoint
in a new `services/content/migrations/2161_content_exclusion_reconciliation.sql`:
one consumer key, graph epoch and last variant IRI. Store only traversal progress,
not eligibility decisions. Reset on epoch change and repeat a completed sweep
when new legacy heads require reconciliation; native CAS makes replay harmless.
Verify the retained publication receipt and exact current head, then CAS only
when no exact current eligibility exists. A concurrent approval wins or causes
an explicit stale retry; it is never overwritten. Missing/corrupt publication
proof stays unresolved. Run this bounded reconciliation before projection on
startup and subsequent worker ticks, via `services/main/src/composition.ts:618-623`;
resume the cursor after a crash. Rebuild orchestration at
`scripts/operations/search-state.ts:280-288` also invokes the same owner
reconciliation before taking a new fixed cut, not while verifying a frozen cut.
Its bounded pages have an explicit progress/continuation result; do not hide
an unbounded startup sweep inside a worker tick. Item 9 completes rebuild preflight.

Narrow both live and rebuild “declared” inventories to exact current Public
decisions; adding exclusion heads otherwise makes declared count exceed Public
heads. Do not suppress malformed Public heads as if they were valid exclusions:
inventory integrity checks must still reject corruption.

Proof: extend `services/main/tests/content-publication.integration.test.ts`,
`content-eligibility.test.ts`, `content-rebuild-inventory.test.ts`; new
`services/main/tests/content-exclusion-reconcile.test.ts`. Cover publication-
versus-approval race, obsolete approval, same-key replay after approval,
reconciliation restart/pagination over 100 variants, missing native proof,
continuation invalidated by lineage change, and mixed excluded/Public counts.

IDs: prerequisite to SEARCH08/SEARCH20/OPS10; no independent green claim.
**Mechanisms: A publication is excluded until exact approval; default creation
and legacy reconciliation belong to the eligibility owner. Native image build:
reuse item 7's image**; additional native change only if implementation reveals
a missing atomic-publication validator, which must be recorded before dispatch.

## 9. Deliver later eligibility changes durably into Content projection

**A prerequisite to terminal release.** One Luna/max session after items 7-8.

Files/lines: `eligibility.ts:337-342`, `modules/outbox/relay.ts:530-540`,
`services/content/src/core.ts:835-877`,
`services/content/src/event-sequencer.ts:27-37,47-59`,
`services/main/src/modules/content-publication/relay.ts:257-278,393-410`,
`services/main/src/composition.ts:618-623`. New file:
`services/main/src/modules/content-publication/eligibility-delivery.ts`.

Consume succeeded eligibility graph events from the existing retained Main relay
handoff in bounded stream-scoped pages, with a distinct durable consumer
checkpoint. For each exact owner decision, idempotently append projection work
to the existing Content receipt/outbox/sequencer. Deduplicate with a deterministic
operation UUID derived from immutable graph event/receipt identity; digest binds
graph position, resource/variant/publication and eligibility head. A duplicate
with different data conflicts. Advance delivery checkpoint only after Content
commit; a crash before relay-consumer acknowledgment replays the same receipt.
No direct graph-to-Postgres distributed transaction or new queue.

At `scripts/operations/search-state.ts:280-288`, before freezing a new rebuild
job on the existing stopped-writer stack, finish the bounded exclusion
reconciliation, capture the Main stream handoff frontier, deliver through that
frontier, and sequence committed Content ingestion. Then take the Content cut.
Expose preparation progress and enforce the existing preparation budget rather
than an unlimited loop. Resuming an already frozen job must use its retained
frontiers/cut and pause background ingestion that would advance that cut; if
new source work is needed, explicitly start a new job instead of changing the
old job's basis. Test preflight/resume in
`services/main/tests/content-rebuild-resume.test.ts`.

Add a narrow Content owner ingestion method; do not bypass `ContentCore` with
ad hoc outbox inserts. Add an eligibility-change event recipe that resolves its
original settled publication pin; current `readProjectionPublication` accepts
only `publication.settle` events and cannot be called unchanged on this new
event. Projection uses the same target ordering and one-event cursor unit. Its
identity includes the new eligibility event, so later Public approval cannot
reuse the completed publication event's identity/digest. Obsolete approval of
an old publication is terminal superseded; unresolved current proof is retained.
Wire the bounded ingestion tick before body projection in the existing worker.

Add `services/content/migrations/2162_content_eligibility_delivery.sql` registering the
new ingestion action in the existing `content.receipt_action` owner
(`services/content/migrations/022_receipt_action_registry.sql:4-11`). Preserve
every existing action; do not restore a parallel CHECK list. This is delivery custody, not a second eligibility
decision. Restored epochs must not replay a foreign current owner head.

Proof: new `services/main/tests/content-eligibility-delivery.test.ts`, extend
`services/main/tests/content-projection.integration.test.ts` and
new `services/content/tests/content-eligibility-ingestion.test.ts`. Cases: exclusion
completed then Public approval, graph commit before ingestion, Content commit
before consumer acknowledgment, duplicate replay, digest conflict, wrong epoch,
old approval after a newer publication, restart and approval/rebuild race.

IDs: prerequisites for SEARCH08/SEARCH20/OPS10 liveness proof. **Mechanisms:
Eligibility changes create durable idempotent Content projection work; completing
publication delivery does not discard later approval. Native image build: no
additional build.**

## 10. Release decided-ineligible events with exact proof and target ordering

**A.** One Luna/max session after item 9; enable only when its recovery path passes.

Files/lines: `content-publication/relay.ts:67-130,294-334,367-410`;
`services/content/src/projection-cursor.ts:46-87,118-149`.
New migration: `services/content/migrations/2163_projection_delivery_disposition.sql`.

Extend the graph lookup to distinguish exact Public, exact excluded, and
unresolved proof. Terminal `ignored` is allowed only after valid settled
publication, current exact publication head, one current exclusion decision,
and its matching succeeded owner receipt have all been proved. Compare exact
resource/variant/publication, graph lineage/control position and restore hold.
Missing decision, malformed receipt, cancelled/stale approval, old-publication
exclusion and a private draft projection remain unresolved. Check exclusion
before requiring body extraction; excluded bytes need not be admitted to public
search or read merely to acknowledge exclusion. Keep existing suppression and
erased-source refusal semantics, including the changes from `ea03d3b0a`.

Before acknowledging exclusion, require item 7's native cleanup command to
prove no stale public body unit remains for this exact excluded head. Re-enter
the deterministic cleanup command on uncertain response; a historical receipt
alone cannot certify physical Lucene state after a crash. This is required
because `search.ts:120-146` counts every physical Content MatchUnit and rejects
`eligible !== contentUnits`. Deleting the pending row alone still blocks
readiness after a previously Public revision. If the head now names a newer
approval, resolve its proof/work instead of deleting that newer unit.

Store only a durable delivery disposition referencing the eligibility-owner
receipt, source epoch/sequence/event/consumer and terminal reason; it records
proof used, not privacy policy. Commit it atomically with source acknowledgment
or pending deletion/checkpoint advancement. Use a unique source-delivery key
and reject conflicting proof on replay. Retain owner decision/receipt according
to existing custody rules. Existing projected events already have deterministic
native graph receipts (`relay.ts:33-38,215-224,330-334`); do not add a second
successful-projection receipt.

For retry completion, under the existing checkpoint row lock require that the
event is still the oldest pending event for its target. Reject out-of-order
completion; an idempotent already-finished retry may return its retained
disposition. Remove only that event, promote the next same-target event and
recompute `min(pending)-1` coverage in one transaction. Never skip an unresolved
predecessor, use scan as completed, or release based on retry count.

Also update the rebuild adoption path in `content-publication/rebuild.ts:324,1045`,
`scripts/operations/search-state.ts:318` and `projection-cursor.ts:170-178`.
The public worker parks while quarantine is closed (`relay.ts:366`), so its
pre-existing retained rows do not disappear merely because the independent
rebuild consumer completed. Before adoption, reconcile only public pending
source events whose exact epoch/sequence/event/target terminal disposition is
proved by this verified rebuild replay at its fixed cut. Record target terminal
dispositions for projected/superseded/excluded events, referring to existing
native/owner receipts, so this reconciliation needs no second eligibility rule.
Delete only proved rows and update target heads/count/coverage atomically;
missing proof or a row beyond the cut refuses adoption. Never globally clear
pending rows. Require the exact owner cut and verified index before using these
rebuild dispositions to promote the public consumer. Repeated adoption is
idempotent. Extend `content-rebuild-resume.test.ts` for this path.

Proof: new `services/content/tests/projection-cursor.test.ts` and extend
`services/main/tests/projection-isolation.test.ts`. Use the owning PostgreSQL
test tier for real transaction/rollback/concurrency cases. Prove two events on
one target, independent target progress, unresolved predecessor, out-of-order
completion, two competing acknowledgments, proof mismatch, epoch change,
rollback between disposition and checkpoint update, and replay after lost
response. No live public MatchUnit may exist for the excluded decision.
Also cover a Public-to-excluded revision and crash during native cleanup.

IDs: SEARCH08/SEARCH20/OPS10 liveness coverage, validated fully by item 12.
**Mechanisms: Terminal projection delivery requires exact owner proof and
preserves oldest-first target order and contiguous completed coverage. Native
image build: no additional build.**

## 11. Bound pending retention without losing unresolved source events

**A.** One Luna/max session after item 10 (which creates the shared cursor test);
the capacity rule is independent of negative-policy semantics.

Files/lines: `projection-cursor.ts:4,59-85,101-145`;
`services/content/migrations/860_projection_checkpoint.sql:7-27` (read-only
historical migration; add a new migration);
`services/main/src/operations/backpressure.ts:20-24,77-86`,
`services/main/src/composition.ts:260`,
`scripts/operations/rebuild-content-search.ts:125`. New migration:
`services/content/migrations/2164_projection_pending_count.sql`.

Reuse the existing worker capacity, **1,000 pending events per consumer and
Content epoch**. Pass the owning worker budget into cursor mutation paths; do
not make Content import Main or create an independent configurable policy.
Add/backfill a pending count with non-negative constraint, maintained under the
existing checkpoint lock on insertion/completion. Avoid scanning an unbounded
pending inventory for each admission.

At capacity, run the normal eight oldest-target retries first, then refuse only
an additional retained insertion with a typed saturation outcome and the
existing worker retry-after of five seconds. That refusal must leave both scan
and completed unchanged; no eviction, event drop or false completion. Surface
saturation through the existing worker operational fault/progress mechanism.
Legacy counts above capacity are preserved, stop growing and drain through
normal proof-based completion; do not delete them to make a CHECK pass. Keep
count and pending rows consistent across rollback, epoch refusal and restart.

Admission backpressure currently measures owner minus completed position; it
limits future normal writers but is not a hard bound on restored/rebuild or
privileged source inventories. The cursor bound remains necessary. Retry budget
is a per-call bound, not a storage bound or a guarantee of throughput.

Proof: cursor test from item 10, existing `projection-isolation.test.ts`,
`tests/qa/integration/backpressure-operational-bounds.test.ts`. Cases: 999/1,000/
1,001 boundary, concurrent retain attempts, completion frees one slot, rollback
does not leak count, restart restores count, retained same-target order, fair
eight-target retries at cap and over-cap legacy preservation. No throughput
qualification was measured here.

IDs: SEARCH08/SEARCH20/OPS10 adverse-state coverage; no claim this alone fixes
run-9 red IDs. **Mechanisms: Pending projection retention is capped transactionally
at worker capacity; saturation preserves source position and retry progress.
Native image build: no.**

## 12. Prove private publication, later approval and rebuild recovery together

**A validation.** One Luna/max session after items 7-11. New file:
`tests/qa/fault-recovery/content-private-projection-rebuild.test.ts`.
Reuse existing fixture helpers from `content-rebuild-positive.test.ts` and
`content-projection-crash.test.ts`; change no trust-ops erasure tests.

Create one active excluded text publication, an unresolved/corrupt-proof
publication and an unrelated Public publication through the real owner flows.
Include a live consumer that already retained the excluded event before
quarantine; its exact rebuild proof must retire that pending row before adoption.
Crash after the default owner decision commits but before delivery acknowledgment;
restart and prove that excluded delivery reaches completed cut with no public
unit. The unresolved proof must still block completed coverage and activation;
repair its exact proof and show Public phrase search/health readiness recover.
Quarantine and replay a fixed owner cut, run the existing pinned offline native
index rebuild/restart sequence, then prove activation and checkpoint adoption
succeed with the excluded publication present. Approve that exact publication
later and prove exactly one correct public body unit appears; replay and crash
between ingestion and acknowledgment must not duplicate it. Repeat with two
ordered changes on its variant and a concurrent newer publication.

Register the new exact test titles in `scripts/qa/coverage/search-projection.ts`
(SEARCH19), `scripts/qa/coverage/ops-erasure.ts` (SEARCH20) and
`scripts/qa/coverage/ops-search.ts` (OPS16), using only the assertions actually
exercised. Add a paging continuation before rebuild and assert explicit restart
after activation if also claiming SEARCH08. Without an erasure campaign in this
file, do not claim it alone qualifies OPS10.

IDs: SEARCH19/SEARCH20/OPS16, and SEARCH08 only with that paging assertion.
These are new liveness proofs; the original OPS10 red case remains item 5.
Re-run existing
`tests/qa/fault-recovery/erasure-search-rebuild.test.ts` separately to determine
whether its run-9 cause is also repaired; do not label its saved draft as the
private-active counterexample. **Mechanisms: items 7-11. Native image build:
item 7's profile/validator image required; no further build prescribed.**

## 13. Settling the reported erasure-search-rebuild failure

**A diagnosis remains open** because incomplete recovery blocks activation.
The brief's six alone reproductions were run; this additional file was inspected
statically and its run-9 stack read, not reproduced in this worker. No corrective
implementation is specified without an exact pending-event/proof trace.

Next evidence: reproduce that file alone with instrumentation in its own future
claim capturing `read`, `readScan`, owner cut and ordered pending event identities
at `:271-274`; correlate each with exact publication and eligibility receipt.
If the blocker is the class above, reuse items 7-12. If it is a retained-erasure
receipt/frontier defect, hand that exact evidence to trust-ops rather than add a
second reconciliation mechanism. IDs: OPS10 and the file's registered search
IDs (SEARCH20/SEARCH08/WORK10/OPS10 in its current title). **Mechanisms: none until cause is established. Native image build:
unestablished; reuse pinned image for the reproduction.**

## 14. Malformed retained-envelope diagnostic hardening

**B: can follow opening.** The invalid synthetic envelope throws TypeError at
`outbox/relay.ts:209` instead of a structured `RelayCheckpointConflict`. The
fixture fix in item 3 restores its intended valid-source proof; no valid
production envelope regression was established. A later small patch can validate
both position representations before dereferencing and test absent/corrupt
position in `services/main/tests/outbox.test.ts` (new if absent). Do not accept
malformed data or weaken stream equality. No acceptance-green claim beyond
diagnostic quality. **Mechanisms: none. Native image build: no.**

## 15. Expose the default head and keep real approval clients on the owner CAS

**A contract prerequisite.** One Luna/max session with item 8; do not activate
default creation without this consumer migration.

Files/lines: `content-publication/publish.ts:43-49,341-369,392-394`,
`services/main/src/api-responses.ts:322-327`,
`services/main/src/routes/content.ts:305-365`,
`services/main/src/routes/studio.ts:128,172`,
`apps/web/features/studio/content-api.ts:194-207`,
`apps/web/features/studio/fixtures.ts:432-437`.

Add a nullable `defaultEligibilityDecision` to publication result/schema,
present for the exact succeeded publication created under item 8, null for
pending/rejected and historical receipts without such a default. It is the
immutable default decision created by that publication, not a claim that it
remains the current head after later approval. Preserve it on same-key replay.
The existing authorized Studio variant read already exposes current
`eligibilityHead`; prove it returns the owner's exclusion or Public head without
inferring Public visibility from a non-null value.

For immediate approval after fresh publication, use the returned default as
`expectedEligibilityHead`, replacing the prior-publication/null value at
`content-api.ts:207`. For an already existing publication, use the authorized
current variant read. A concurrent newer decision still produces stale/restart;
do not weaken the owner's CAS or assume null means default. Publication replay
followed by replay of the same approval key keeps the original result; a new
approval key using obsolete default must fail stale and reread current state.
Update Studio fixture responses to simulate default creation and the same CAS.
No new public operation is prescribed.

Proof: extend `services/main/tests/content-publication.integration.test.ts`,
`services/main/tests/content-eligibility.test.ts` and
`apps/web/tests/studio-chapters.test.ts:104-119` with first publish, republish,
lost-response replay, concurrent approval and stale reread. Run owning
generators and `task web:typecheck` for the changed route result; generated
outputs remain uncommitted. IDs: SEARCH19 and existing Studio publication case
IDs; prerequisite, not full qualification. **Mechanisms: Existing eligibility
heads remain server-owned CAS inputs and are discoverable to approval clients.
Native image build: none beyond item 7.**

## 16. Migrate the remaining publication-to-approval fixtures

**A qualification prerequisite.** After item 15, dispatch as the three
independent Luna/max sessions below; the complete caller inventory is too broad
for one verified session. Each uses the same returned-head migration and
mechanism/image requirements. This is caller migration to the same owner
decision, not a new eligibility mechanism.

Update positive approval setup to consume the fresh publication's returned
default head, or an explicitly read current head for existing publications. Keep
null only where the test intentionally proves an absent-head stale/invalid
case. Do not mechanically replace every null in `content-eligibility.test.ts`.

The inspected caller inventory is:

- `apps/web/tests/work-page-seed.ts:190-192`,
  `apps/web/tests/tracking-media-seed.ts:103-105`.
- `services/main/tests/content-projection.integration.test.ts`,
  `services/main/tests/work-contents.integration.test.ts`.
- `tests/qa/integration/content-publication-native.test.ts:149,411`,
  `post-lifecycle.test.ts:122`, `content-variant-order.test.ts`,
  `content-public-domain.test.ts`, `post-search-disclosure.test.ts`,
  `search-studio-chapter-content.test.ts`, `access-author.test.ts`,
  `authenticated-api-journey.test.ts`, `structure-book-volumes.test.ts`,
  `structure-book-embeds.test.ts`, `tag-proposal-support.ts`, `feed-read-support.ts`,
  `feed-home.test.ts`, `g-538-translation-basis.test.ts`,
  `g-591-contribution-basis.test.ts`, `post-identification.test.ts`,
  `post-author-notes.test.ts`, and `post-addresses.test.ts` (all names after the
  first here are relative to `tests/qa/integration/`).
- `tests/qa/fault-recovery/content-rebuild-positive.test.ts`,
  `tests/qa/fault-recovery/content-projection-crash.test.ts`,
  `tests/qa/load/corpus.ts`.

Session 16a owns the two web seeds, the two Main tests, and integration
`content-publication-native`, `content-variant-order`, `content-public-domain`,
`post-search-disclosure`, `search-studio-chapter-content`. Session 16b owns
integration `access-author`, `authenticated-api-journey`, `g-538-translation-basis`,
`g-591-contribution-basis`, `post-lifecycle`, `post-identification`,
`post-author-notes`, `post-addresses`. Session 16c owns the remaining structure,
tag/feed support and feed-home files, the two fault files and load corpus.
These names refer to the exact `.test.ts`/support paths listed above; sessions
claim disjoint files. Each runs its own affected fixture cases, not all three
groups, and reports their existing acceptance IDs without widening assertions.

Search `expectedEligibilityHead` within these files to relocate each call site;
read its preceding publication result, do not invent a second default-head
calculation. The original null/previous-head assumptions become stale once the
default is installed. Preserve deliberate reversed settlement, sparse variants,
rights denial, unapproved-body and replay cases. This migration can be mechanical
at valid positive setups; do not change assertions to accept stale approval.

Trust-ops overlap: `tests/qa/integration/erasure-published-search.test.ts` and
`tests/qa/fault-recovery/erasure-search-rebuild.test.ts` also contain approval
callers. Notify their owner of the changed contract; this report does not
prescribe reconciliation edits there or in the four protected files from the
brief. Their affected cases remain manager/owner follow-ups.

Proof: the owned unit/integration/fault fixture files retain their existing
acceptance assertions after the caller migration. Run focused own files through
goalctl, list cross-owner affected tests for manager regression, and do not run
whole tiers. IDs: their existing SEARCH19/SEARCH20/OPS16 and publication
acceptance IDs; no independent claim of full acceptance. **Mechanisms: none
additional. Native image build: reuse item 7.**

## Research limits and manager dispatch

PostgreSQL's [row locking documentation](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
supports serializing cursor mutations under the existing checkpoint row lock;
locks end with the transaction. Its [SELECT locking documentation](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)
warns that SKIP LOCKED yields an inconsistent view suitable for queue selection,
not general coverage. Queue selection never proves completed coverage here.
The four proposed migration numbers above are free in this checkout but are
not reserved by this read-only worker; the manager assigns/renumbers them when
dispatching. These primary sources support the transaction mechanics only; the exact owner
proof, ordering and 1,000-row capacity are REZICS decisions and require the tests
above. No new library or orchestration framework is proposed.

Dispatch items 1-5 as the bounded run-9 repairs; retain the two passing repairs
in item 6. Items 1 and 2 touch the same file and must be sequential. For the A
liveness class, adopt the explicit default-exclusion contract, then item 7,
items 8/15/16 as a contract milestone, then 9, 10, 11 and 12; items 9/10 form
one terminal-release activation milestone. Item 13 needs evidence
before an implementation claim. Item 14 is B. There is no C product work
required by this report; redundant fixes to already repaired symptoms should
be deferred.

Unestablished: later coordinated restore stages behind its first gate; Event
stages behind missing pool; campaign performance after its missing-backup gate;
the private-active cause in the reported erasure-search-rebuild failure; current
backup timing, pending-cap throughput and the proposed exclusion fault outcome.
The named focused reruns/fault traces settle those claims. Main-wide acceptance
qualification belongs to the manager's regression. No product/test edits,
owner changes, migrations or generated outputs were made in this worker.
