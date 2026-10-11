# Closed-by-default Content projection without default eligibility records

Read-only addendum to G-1641, investigated on `79fad0e06`, 2026-10-11. The
referenced report is absent from this checkout and the main checkout; its
committed text was recovered with
`git show a550309b0:docs/goals/kernel/reports/G-1641-specification.md`.
References to its numbered items below mean that version. Current source line
numbers must be relocated after rebasing. Only this report is changed.

**Recommend closed by default without a default decision, with the repairs
below. The one-line skip rule is insufficient today.** Later Public approval
is durable in Main's graph outbox, but does not deliver Content body projection.
A replacement publication also retains an older eligibility head and stale
body unit. These are A findings: existing projection/readiness functions are
incomplete. Both candidate designs need durable approval delivery; a default
decision does not repair it. Existing native command machinery can express
atomic stale-body cleanup without a new profile or native image build.

This recommendation changes projection disposition, never read visibility or
copyright assessment. Public eligibility remains the existing owner's exact
positive decision. Absence means no permission to project. A present corrupt
or unproven head remains unresolved and blocks completed coverage. There is no
second policy registry. Trust-ops must review this meaning before activation.

## 1. What the relay can distinguish today

| State | Evidence and present behavior | Classification and proposed treatment |
| --- | --- | --- |
| No raw eligibility head | `services/main/src/modules/content-publication/relay.ts:91-98,128-130` returns the raw optional `eligibility` separately from `eligibleDecision`. `:312-313` defers it anyway. | **A:** a proved absence can be terminally evaluated without creating an eligibility decision. Prove the settled publication, current exact publication head, lineage and open restore gate first. |
| Exact Public head | The optional join requires decision type, resource, variant and Public disclosure at `relay.ts:95-98`. Native projection then validates profile and exact links at `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java:1435-1461,1526-1536`. | Existing positive owner path remains. A superficially Public triple is insufficient proof. |
| Head whose decision is non-Public | The raw head can be seen, but the Public-only join has no binding. It looks like other failed joins. The owner accepts only `disclosure: 'public'` at `eligibility.ts:28-38,74-84`; both profiles require Public at `model/definitions/content-search-eligibility-v1.ttl:15-16` and `content-search-eligibility-v2.ttl:15-17`. | **A:** classification is incomplete. No valid owner-created non-Public decision exists under today's profiles. Such present data is unproven, not a terminal exclusion. **C:** defer adding a negative-decision capability unless Trust-ops identifies a separate need for one. |
| Corrupt/unproven head | Missing decision/type/resource/variant/publication/disclosure can all omit `eligibleDecision`; duplicate results fail the singleton check at `relay.ts:109`. Public-looking corruption can reach native refusal. | **A:** never equate failed Public join with absence. Validate raw singleton head, immutable decision and its exact succeeded owner receipt; ambiguous, missing or foreign proof remains pending. |
| Valid older Public decision retained on the variant | `publish.ts:190-201` replaces `contentPublicationHead` but leaves `publicSearchEligibilityHead`. E1 can legitimately point to P1 while the current publication is P2. | **A:** prove E1/P1's retained owner records and that P2 is the exact current succeeded publication. E1 is a superseded approval, so P2 has no current approval. This is neither corruption nor approval of P2. Missing E1/P1 proof remains unresolved. |

The last row is essential. A rule releasing only a missing *raw* head fixes the
first publication but leaves normal replacements deferred forever. The useful
rule is “no proved Public approval **of this current publication**,” with an
explicit distinction between proved absence/superseded authority and failed
proof. Do not clear the old eligibility pointer merely to make the first case
apply: that changes existing approval CAS inputs unnecessarily.

The read must retain all raw candidates before classification. Filtering the
inventory to successful Public joins alone would hide corruption. Reuse the
existing eligibility owner records: `eligibility.ts:211-270` checks succeeded
receipt fields, binding, admission, scope, rights, epoch and deterministic
decision identity; `rebuild.ts:761-788` joins exact publication and eligibility
receipts. Historical-head validation verifies retained historical authority;
it does not assess rights again or approve the newer publication. Preserve
native positive admission, current assessment and profile checks.

## 2. Counterexamples and repairs

### Later approval: durable event, missing body consumer — A

Approval atomically inserts the head, decision, receipt and
`ContentSearchEligibilityEvent` in `eligibility.ts:325-342`. Main relay maps it
to `com.rezics.content.search-eligible.v1` at
`services/main/src/modules/outbox/relay.ts:530-535`, binds its decision/variant
at `:584-590`, and retains delivery before advancing the checkpoint at
`:1673-1749`. A lost relay acknowledgment repeats safely. Its explicit existing
actionable consumer, `work/serial-projection.ts:320-346`, refreshes serial facts,
not Content body MatchUnits.

The body worker at `services/main/src/composition.ts:618-623` calls the Content
relay, which reads only Content's PostgreSQL outbox (`relay.ts:384-402`;
`services/content/src/core.ts:833-842`). Today the original unapproved publication
remains pending; that retry is how later approval eventually reaches body
projection. Terminally skipping it removes that route. A default exclusion
record followed by terminal acknowledgment has exactly the same problem.

Repair: retain G-1641 item 9's owner-controlled, idempotent bridge from retained
Main events into the existing Content receipt/outbox/sequencer. The bridge is
delivery custody, not an eligibility decision. Consume bounded stream-scoped
pages using `verifiedRetainedRelayRange` (`outbox/relay.ts:222-269`), a durable
consumer checkpoint, and immutable source identity/digest. Advance the bridge
checkpoint only after Content commits. A new Content action needs a registry
migration (`services/content/migrations/022_receipt_action_registry.sql:4-11`).
The append/sequencer already supplies atomic receipt/event creation and restart
numbering (`services/content/src/event-sequencer.ts:27-37,43-59`).

Reusing `settlePublication` cannot redeliver: a previously settled preparation
returns without a new event (`core.ts:748-752`), while
`readProjectionPublication` insists on terminal publication events and the
`publication.settle` receipt (`:848-860`). Add a narrow ingestion action and
resolve its reference to the original settled pin. Do not insert ad hoc outbox
rows or relabel eligibility delivery as publication settlement.

A direct second projection consumer over Main could avoid this action migration,
but would introduce another completed frontier/retry lane to combine with every
readiness, ordering and rebuild gate. No such composition is implemented or
proved. **C:** defer that alternative; the one Content projection stream is the
smaller evidenced repair. “No Content migration” is not justified for the
recommended design.

### Ordering and concurrent newer publications — A repairs, reusable guards

Closed evaluation does not inherently break target ordering. Later same-target
events are retained at `relay.ts:403-410`; retries choose only the oldest pending
event for each of eight targets (`projection-cursor.ts:94-112`). Releasing a
proved closed event allows its successor to run. Other targets already progress
independently. Keep these rules for ingested approval events as well.

An approval of P1 delivered after P2 must be terminally superseded, never project
P2 using P1's approval. Pre-read supersession at `relay.ts:297-300` and atomic
publication/eligibility WHERE guards at `:235-245` fence concurrent publication.
The ingestion event must bind the exact approval and original P1 pin. Stale
native CAS causes re-evaluation; it never authorizes a stale write or skip of
an unresolved predecessor. `finishRetry` currently removes the supplied event
without rechecking it is still the target's oldest (`projection-cursor.ts:131-138`);
add that guard under the checkpoint lock for concurrent callers.

There is a second identity race: project P1 using E1, lose acknowledgment, then
approve the same P1 using E2. Current receipt identity is only source event plus
rebuild id (`relay.ts:33-38`), but its digest includes eligibility (`:323-326`).
Recomputing it with E2 conflicts with the committed E1 receipt
(`CommandService.java:986-991`). Approval events therefore need distinct source
identities; retries also need to recognize a committed original descriptor
superseded by a proved newer eligibility decision with durable successor work.
Do not replay E1 as current authority: native repair intentionally refuses changed
pins (`SearchDeltaJournal.java:486-490`). Preserve exact re-entry/repair while
the original authority remains current; otherwise prove supersession and let
the distinct newer event deliver. Test this race separately from a newer P2.

### Old Public body remains after skip — A, no new native mechanism

Concrete case: project P1/E1/U1, publish P2, then never approve P2. Publication
retains E1 and U1. Returning `ignored` does not remove U1. Readiness counts all
physical Content units, including U1 (`search.ts:120-146`); it still refuses.
Native source-head changes fence old text, but do not remove its RDF unit
(`SearchDeltaJournal.java:727-739,820-823,884-898`). Do not claim a demonstrated
read disclosure; the established failure is stale physical inventory/readiness.

The smallest ongoing repair is to remove the old variant's Content MatchUnits
**inside the existing succeeded publication command** (`publish.ts:189-245`).
Add deletion of all triples of units bound to this variant and a Content
projection, constrained to the Content MatchUnit identity family. The same
existing current-publication CAS (`:237-240`), restore guard and native transaction
then remove old bodies before P2 can be evaluated as closed. Preserve immutable
projection anchors and receipts. Reject malformed/over-budget inventories;
do not delete unrelated variants or other MatchUnit families.

Existing native support is sufficient in source:

- `CommandPolicy.java:133-135` permits public-search changes accompanying a
  product current/revision mutation, which publication already performs.
- `SearchDeltaJournal.java:796-799` permits deletion-only changes without a
  new MatchUnit receipt claim; `:420-425` skips delivery-source retention when
  there is no such claim; `:859-869` journals deleted units with empty source.
  Explicitly touched deleted units are excluded from stale-head handling at
  `:820-823`. Preserve its existing delta bound (`:758-778`).
- Matching publication receipt replay returns before update execution
  (`CommandService.java:986-998`); its receipt has no MatchUnit claim, so native
  Content repair returns at `SearchDeltaJournal.java:474-479`. Retrying P2 after
  later P2 approval does not re-execute deletion against its newer unit.

These are source-derived capability claims, not executed native qualification.
No authored model/profile or Java implementation change is prescribed. Use the
existing pinned image for proving native integration tests. An offline native
indexer run during rebuild is an operation, not a native **image build**.

Legacy P2 publications can already have U1. Changing a command template does
not rerun a committed receipt. Roll out on the existing stopped-writer rebuild
path: quarantine, bounded existing Content-unit clear, fixed-cut replay and
verified activation/adoption. That removes legacy stale units without authoring
legacy exclusion decisions or adding an owner reconciliation traversal. Do not
enable the new live terminal rule on an unrepaired legacy index and claim ready.

### Crash between evaluation and acknowledgment — A composition requirement

For proved absence, evaluation has no graph mutation. If it crashes before
`acknowledge`, the source event is read again. If approval arrives meanwhile,
re-evaluation can project it rather than exclude it; that is correct current
state evaluation. If exclusion was acknowledged first, the independently retained
approval must still ingest and project. The bridge closes both interleavings.

`projection-cursor.ts:46-87` advances exactly one source event and commits pending
retention/scan/completed coverage together. `:118-149` commits retry completion
and target promotion together. A new per-exclusion receipt or disposition table
is unnecessary for this no-side-effect evaluation. Existing graph receipts own
successful projection and publication cleanup. Keep missing/corrupt proof pending
and retain source rows across rollback, restart and lost acknowledgment.

### Fixed owner cut and rebuild equality — A for missing delivery, C for historical replay

At Content cut C, live projection excludes P with no approval. Approval then
advances graph sequence G but leaves Content C unchanged. Rebuild at C now sees
current approval and projects P: `rebuild.ts:703-724` checks only Content owner
position during replay, while `relay.ts:91-98,294-313` reads current graph heads.
Thus a **Content-only historical cut does not identify the historical live set**.
Default exclusion records do not solve this: current heads still change, and
neither design performs historical as-of eligibility resolution.

The existing rebuild instead verifies current state at a stable graph snapshot
(`rebuild.ts:883-900,1000-1003`) and activates under exact graph-sequence CAS plus
Content owner lock (`:1020-1037`). Preserve this intended current-state contract:
on stopped writers, drain Main handoff through a captured frontier, ingest all
eligibility events through it, sequence committed Content events, then freeze
Content C. Compare the expected set from exact current owner proofs with both
live completed projection and rebuild at that **joint stable state**. Projection
commands advance graph sequence, so freeze eligibility/publication writers, not
the graph's numeric sequence throughout the entire replay. Verification then
captures its final exact graph sequence for activation.

On resume, never ingest new work into an already frozen C. Resume retained
frontiers or refuse/start a fresh job when owners moved. **C:** defer historical
live-at-an-earlier-C replay; no such requirement or existing temporal eligibility
resolver was established. If Program actually requires it, both proposals need
additional historical authority/cut design; this recommendation does not satisfy
that different contract.

### Erasure supersession — preserve existing owner path

`relay.ts:282-292` checks exact erasure supersession before body reads, using
`core.ts:301-321` and exact graph suppression. Erasure records that supersession
with revision tombstoning (`services/main/src/modules/erasure/content.ts:201-213`).
Approval-triggered work must resolve the historical settled pin, then take this
same path. An old approved publication whose bytes have been erased is superseded
only by that exact retained authority; bare missing eligibility/head is not an
erasure proof. Missing suppression stays unresolved. **A:** cover the new delivery
adapter with existing erasure semantics. No new erasure authority/reconciliation
is needed or prescribed; Trust-ops owns erasure qualification.

## 3. Completed means evaluated coverage, not number of public units

`projection-cursor.ts:34-42,83-85` defines completed as `min(pending)-1`, or scan
when no pending remains. Valid closed, rejected, non-text and superseded events
can all be completed without projecting a body. This already matches other
terminal paths (`relay.ts:294-304`). Keep the definition; never substitute scan
for completed. Any unresolved current owner proof still blocks completed.

| Gate | Current evidence | Effect/required repair |
| --- | --- | --- |
| Content phrase search and public readiness | `search.ts:151-175,272-278,289-293`; combined Main query at `work/search-public.ts:57-61,208-215` | Completed must equal current Content owner position. Proved closed events may count; exact Public inventory must still match physical units. |
| Health | `services/main/src/routes/health.ts:95-108` | Consumes Content readiness; no new readiness definition or bypass. |
| Current search generation | `services/main/src/routes/search-generations.ts:35-45` | Same readiness chain; it remains unavailable for unresolved proof. |
| Rebuild replay/verification/activation | `rebuild.ts:703-724,878-881,1017` | Exact completed cut remains required. Freeze joint authority after ingestion, classify all raw heads, and verify physical set. |
| Checkpoint adoption | `projection-cursor.ts:170-178`; callers at `rebuild.ts:324,1045`, `scripts/operations/search-state.ts:318` | A successful independent rebuild leaves parked live pending rows. Adopt only after exact proved-prefix reconciliation below. |
| Backpressure | `services/main/src/operations/backpressure.ts:77-86`; existing capacity at `:20-24` | Owner minus completed measures unresolved delivery lag. Closed events release lag; corruption does not. Preserve independent pending capacity work. |

**A inventory repair:** `search.ts:77-91` counts every eligibility head as
declared, but only exact current Public heads as heads; `:145-146` rejects a
valid retained E1/P1 on current P2. Rebuild does the same at
`rebuild.ts:752-788,915-929`. Classify raw heads using the one resolver; count
only proved *current* Public authority in expected body inventory, separately
reject every unresolved present head, and require no units for proved closed
current publications. Do not merely weaken equality or filter malformed joins
away. Keep physical RDF/Lucene correspondence and body/source checks
(`rebuild.ts:937-995`; `SearchDeltaJournal.java:351-388`).

**A adoption repair, without a disposition registry:** the live worker parks
during quarantine (`relay.ts:361-366`), so its old pending rows can survive an
independently completed replay. Existing verified completed-prefix coverage
already proves every retained source event through C was terminally evaluated.
Under owner and both consumers' checkpoint locks, validate parked rows against
immutable outbox id/epoch/sequence and target resolved from the settled pin;
require matching replay epoch, completed C and no replay pending, exact current
owner C, and verified activation of this rebuild. Retire only validated rows
within that prefix, recompute targets/coverage and promote atomically. Reject
foreign, malformed or beyond-cut rows. Never globally clear pending.

Current adoption permits owner >= C (`projection-cursor.ts:166-167`); this
reconciliation must require equality. Keep writers and live projection stopped
through SQL adoption, including recovery after graph activation. Resume currently
checks epoch/generation/anchor but not unchanged graph sequence
(`rebuild.ts:303-325`); require current graph control to match the committed
activation receipt's sequence before using its prefix proof. If it moved,
refuse/reverify rather than certify old state. Existing cursor/activation owners
already make the coverage decision; G-1641's per-event disposition table would
duplicate it for this restricted adoption case. **B:** optional per-event audit
history can follow opening if a separate diagnostic need is established.

## 4. Replacement of G-1641's eight parent items

The eight parent items are 7-12, 15 and 16. Item 16 itself prescribes three
sessions, so that report actually dispatches ten implementation/qualification
sessions, not eight. Do not preserve a session count as a requirement.

| Earlier item | Keep, replace or remove, and why |
| --- | --- |
| 7: exclusion profile, owner proof, native validator/cleanup | **Remove** the negative profile/term/default decision and its native validator. Replace cleanup with the existing publication command's deletion support (session 2). Existing positive profiles remain untouched. No image build justified by this work. |
| 8: atomic default and legacy reconciliation | **Remove** default-head writes and reconciliation/checkpoint migration. Keep only raw-head integrity/current-Public inventory work (session 1). Existing stopped-writer rebuild repairs old physical units; it creates no legacy policy decisions. |
| 9: later eligibility delivery | **Keep**, narrowed to existing positive approval events; split owner ingestion and retained-relay integration (sessions 3-4). Keep a small action/progress migration. Remove exclusion-reconciliation preflight. Freeze delivery frontier before Content cut (session 6). |
| 10: decided-negative delivery/dispositions/order/adoption | **Replace** negative-receipt lookup with closed-state classification (session 1) and terminal evaluation/order (session 5). Remove disposition migration/table. Reconcile verified replay prefix at adoption (session 6), using existing owner coverage, not per-event policy. |
| 11: bound unresolved pending | **Keep independently** (session 7). Corrupt proofs can still accumulate; a retry budget or writer admission alone is not a storage bound. This is not a cost unique to either exclusion design. |
| 12: composed recovery fault proof | **Keep and adapt** (session 8). Crash at no-head evaluation/ack instead of default-decision commit. Add stale-Public replacement and same-publication reapproval races. Reuse its proposed test filename and acceptance scope. |
| 15: publication response default field / Studio CAS migration | **Remove.** No default is created, old eligibility head is retained, and `apps/web/features/studio/content-api.ts:200-207` can keep its existing expected head. Public API shape does not change. |
| 16: publication-to-approval caller migration (three sessions) | **Remove the default-head migration**, including web seeds/load caller rewrites. Change only tests that deliberately assert the old deferred-unapproved behavior (e.g. `tests/qa/integration/content-eligibility-order.test.ts:176-187`), in sessions owning that behavior. Positive CAS fixtures keep their existing contract. |

G-1641 items 1-6 and 13-14 are outside this alternative's scope and remain as
specified. In particular this analysis does not attribute the run-9
`erasure-search-rebuild` failure, whose saved draft is not the active-unapproved
counterexample. The original OPS10 missing-fixture repair remains item 5.

## 5. Bounded Luna/max sessions and proving tests

These are implementation proposals, not changes made or tests executed here.
Every session uses **Mechanisms: none new; consume existing eligibility,
publication, Content event/cursor and rebuild owners.** No session below adds
or replaces a tool. Migration numbers are assigned by the manager, not reserved
by this report. New filenames name capabilities, not task ids. All native image
answers below mean rebuilding the OCI image, not running the pinned image's
existing offline indexer.

### Session 1: classify exact eligibility and qualify inventories — A

Files: `relay.ts:67-130`, `eligibility.ts:211-270`, `search.ts:67-148`,
`rebuild.ts:752-788,810-847,915-929` (these are in
`services/main/src/modules/content-publication/`). Extract a shared owner-record
resolver, e.g. `eligibility-state.ts`, with explicit `public-current`,
`closed-absent`, `closed-superseded-approval`, `unresolved` results. Validate raw
cardinality, retained profiles/decision/receipt identity, exact publication,
resource/variant, lineage, and restore gate. Invent no valid negative head under
Public-only profiles. Share it between live and rebuild inventory; preserve
bounded keyset pages and population bounds. Do not yet enable terminal skipping.

Proof: extend `services/main/tests/content-eligibility.test.ts`,
`content-rebuild-inventory.test.ts`, and add `content-eligibility-state.test.ts`.
Cases: no head, current Public, non-Public under current unsupported profiles,
missing/duplicate/foreign head, malformed Public receipt, valid E1/P1 on P2,
damaged historical receipt, mixed inventory and restore hold. All unresolved
cases refuse readiness/activation; closed cases demand zero physical bodies.
Acceptance: SEARCH19/SEARCH20 prerequisites, not independent full qualification.
**Mechanisms: existing eligibility owner proofs. Native image build: no.**

### Session 2: delete obsolete body units in publication — A

Files: `services/main/src/modules/content-publication/publish.ts:189-245`;
reference native capability at `CommandPolicy.java:133-135` and
`SearchDeltaJournal.java:796-799,820-869`. Add scoped unit deletion to succeeded
publication under its existing CAS, keeping eligibility pointer, API result and
historical anchors. Do not add standalone cleanup authority. Stage rollout with
the existing bounded rebuild for pre-change units.

Proof: extend `services/main/tests/content-publication.integration.test.ts`
and `infra/jena/tests/command.integration.test.ts:241,389` using the existing
image. P1/E1/U1 to unapproved P2 leaves no old RDF/Lucene body; stale publication
CAS rolls back; other variants remain; crash/reopen certifies deletion. Lose P2
response, approve/project P2 as U2, then replay P2 and prove U2 survives. Retain
native malformed inventory/delta-bound refusal. Acceptance: WORK10/SEARCH19,
SEARCH20/OPS16 recovery prerequisites, only assertions actually exercised.
**Mechanisms: existing publication CAS and native search delta. Native image
build: no; if the real native test disproves admission, stop and report the
exact missing capability before proposing Java changes.**

### Session 3: append eligibility-triggered work through Content — A

Files: `services/content/src/core.ts:721-770,846-891`,
`event-sequencer.ts:27-37,43-59`, registry at
`services/content/migrations/022_receipt_action_registry.sql:4-11` (historical,
read-only). Add a narrow owner ingestion action and a new action/progress
migration, e.g. `content_eligibility_delivery.sql`. Reuse receipt/outbox append,
operation lock, sequencer and settled pin. Deduplicate by immutable Main
event/receipt identity and bind source epoch/position, exact publication and
eligibility; mismatched replay conflicts. Progress must not outrun the appended
event. The checkpoint binds the Main stream scope/graph epoch, Content epoch and
last fully consumed batch sequence; append all selected events of a bounded
batch and advance its checkpoint in one Content transaction. A crash before
that transaction commits retains neither its progress nor its new work. Keep
non-eligibility batch traversal contiguous, with expected-progress CAS so two
bridge callers cannot reorder it. Resolve historical metadata for obsolete/erased pins before requiring
body availability. Store delivery progress, never policy decisions.

Proof: new `services/content/tests/content-eligibility-ingestion.test.ts`:
concurrent duplicate, digest conflict, wrong epochs/publication, transaction
rollback, crash after append before numbering, restart numbering, rejected
settlement and exact historical erased pin. Acceptance: SEARCH19/SEARCH20/OPS16
delivery prerequisites. **Mechanisms: existing Content receipt/outbox/sequencer.
Native image build: no.**

### Session 4: bridge retained approvals in the existing body worker — A

Files: Main `modules/outbox/relay.ts:222-269,530-535,584-590` (consume existing
verified API), `modules/content-publication/relay.ts:257-278,384-410`,
`composition.ts:618-623`; new `modules/content-publication/eligibility-delivery.ts`.
Read bounded Main-scoped pages, prove immutable event/receipt bindings and call
session 3 before acknowledging delivery. Bind durable cursor to graph/Content
epochs; never skip a damaged source page. Start from retained coverage sufficient
to redeliver existing approvals, not just future events. Old valid approvals
become superseded only with exact owner proofs. Integrate approval event recipes
and distinct projection identities into the same target lane. Resolve old
committed projection descriptors versus newer valid eligibility as described
above; corrupt replacements remain unresolved. Wire ingestion before projection.

Proof: new `services/main/tests/content-eligibility-delivery.test.ts`, extend
`content-projection.integration.test.ts` and
`tests/qa/integration/content-eligibility-order.test.ts:176-237`. Cover graph
commit before handoff, handoff before ingestion, Content commit before bridge
ack, replay/digest mismatch, startup retained events, foreign epochs,
approval before Content settlement, P1 approval after P2, same-P1 E2 after E1
native commit/ack loss, and erased source with exact suppression. Acceptance:
SEARCH19/SEARCH20/OPS16 prerequisites. **Mechanisms: existing retained Main handoff
consumed into Content custody. Native image build: no.**

### Session 5: terminal closed evaluation and oldest-first retry — A

Files: `services/main/src/modules/content-publication/relay.ts:272-342,367-410`,
`services/content/src/projection-cursor.ts:46-87,118-149`. Enable `ignored` for
session 1's proved closed states before byte extraction/profile projection;
preserve exact erasure check first and unresolved pending. On terminal retry,
recheck oldest target event under the existing checkpoint lock, atomically
promote successor and recompute coverage. An already-finished identical retry
is idempotent. Add no disposition table. Roll out only after sessions 2-4 and
the legacy rebuild/adoption path in session 6 are available.

Proof: new `services/content/tests/projection-cursor.test.ts` in the real
PostgreSQL tier; extend `services/main/tests/projection-isolation.test.ts:72-122,229-264`.
Cases: excluded target and unrelated Public progress, unresolved predecessor,
two ordered same-target events, competing ack/retry, stale out-of-order retry,
SQL rollback, lost evaluation acknowledgment, epoch change, missing source and
erasure-proof refusal. Acceptance: SEARCH19/SEARCH20/OPS16 prerequisites.
**Mechanisms: existing terminal cursor coverage. Native image build: no.**

### Session 6a: joint rebuild preflight and frozen resume — A

Files: `scripts/operations/search-state.ts:237-288,303-318`,
`scripts/operations/rebuild-content-search.ts` (relocate its existing owner setup),
Main `content-publication/rebuild.ts:299-325,372-379,697-724,1000-1045`,
Content `projection-cursor.ts:152-193` is reference material here. Supply the stopped-writer rebuild with
the same delivery owner, finish retained Main frontier/Content sequencing before
new quarantine, and retain frontier with existing rebuild progress. Resume
without advancing an existing cut. Bound preparation using the existing budget.
Keep writers and public poller stopped until session 6b's adoption succeeds.

Proof: extend `services/main/tests/content-rebuild-resume.test.ts` and
focused `tests/qa/fault-recovery/content-rebuild.test.ts`. Drain approvals before
a fresh cut; graph/Content changes refuse; frozen jobs do not ingest later
approvals; crash during preflight resumes the retained frontier; preparation
budget failure leaves the stack closed. Session 6b covers final adoption.
Acceptance: SEARCH20/OPS16, SEARCH08 only where paging restart is asserted.
**Mechanisms: existing verified rebuild prefix/activation authority. Native image
build: no; run the existing pinned offline indexer.**

### Session 6b: verified-prefix adoption and activation recovery — A

After 6a, change `services/content/src/projection-cursor.ts:152-193`, Main
`content-publication/rebuild.ts:299-325,1011-1045` and
`scripts/operations/search-state.ts:303-318`. Reconcile only exact covered parked
rows under owner and both checkpoint locks; require exact cut, successful
verification/activation, and unchanged activation control on recovery. Resolve
each pending target through the original settled pin and share the same narrow
adoption entry point across fresh activation, resumed activation and the
orchestrator's done path. Keep writers stopped until SQL adoption commits.

Proof: cursor tests, `services/main/tests/content-rebuild-resume.test.ts` and
focused `tests/qa/fault-recovery/content-rebuild-positive.test.ts`. Live old
pending plus closed replay adopts; missing/out-of-cut/wrong-target/foreign rows
refuse; transaction rollback preserves rows/counts; competing cursor calls
serialize; crash after graph activation but before SQL adoption resumes once;
changed control refuses; legacy stale units clear and verify. Acceptance:
SEARCH20/OPS16; SEARCH08 only for an asserted paging restart. **Mechanisms:
existing verified rebuild prefix/activation authority. Native image build: no.**

### Session 7: transactional pending capacity — A, independent of exclusion policy

Retain G-1641 item 11. Files: `services/content/src/projection-cursor.ts:4,59-85,101-145`,
new `projection_pending_count.sql` migration;
`services/main/src/operations/backpressure.ts:20-24,77-86`,
`services/main/src/composition.ts:260`,
`scripts/operations/rebuild-content-search.ts:125`. Pass existing worker capacity
1,000 to cursor paths, maintain count under checkpoint lock, backfill/preserve
over-cap legacy rows. At capacity run normal retries, refuse only additional
retained insertion without advancing source positions, and surface existing
five-second retry-after. No eviction, second capacity policy or full inventory
count per event. This preserves finite custody when corrupt proofs never resolve.

Proof: cursor/projection-isolation tests and
`tests/qa/integration/backpressure-operational-bounds.test.ts`: 999/1,000/1,001,
concurrent insertion, completion frees capacity, rollback/restart, fair target
retry and over-cap preservation. Acceptance: SEARCH19/SEARCH20 adverse-state
prerequisites; no throughput or OPS10 qualification claim.
**Mechanisms: existing worker capacity enforced in cursor custody. Native image
build: no.**

### Session 8: composed fault qualification — A validation

Reuse G-1641 item 12's proposed
`tests/qa/fault-recovery/content-private-projection-rebuild.test.ts` and helpers
in `content-rebuild-positive.test.ts` and `content-projection-crash.test.ts`.
Reuse/adapt the first evidence test from G-1696 when available; do not create
another competing reproducer. This worktree does not contain either proposed
new test yet. Create through real owners one active never-approved publication,
one unrelated Public publication, and a separately damaged proof.

Prove: closed publication projects no body yet completed equals owner; phrase
search, health and generation are ready; corrupt proof still blocks all relevant
gates until exact repair; lost evaluation ack recovers; a parked legacy live row
is retired only by verified rebuild prefix; quarantine/replay/activation/adoption
at the joint cut succeeds; later approval durably produces one exact body;
graph/Content/bridge-ack crashes and duplicate delivery recover; P1/P2 ordering,
old Public unit deletion, same-publication E1/E2 acknowledgment race and erasure
supersession all preserve exact current set. Compare owner-derived expected set
with live and rebuilt RDF/Lucene units at the same frozen authority state.

Register only exercised titles in `scripts/qa/coverage/search-projection.ts`
(SEARCH19), `ops-erasure.ts` (SEARCH20) and `ops-search.ts` (OPS16). Include paging
continuation plus restart after generation change to claim SEARCH08. No erasure
campaign means no standalone OPS10 claim. Trust-ops/manager separately reruns
`tests/qa/fault-recovery/erasure-search-rebuild.test.ts` to establish its actual
cause. Run own tests with `bun scripts/goal/goalctl.ts test <files>`; retain run
ids, both cursors, owner/frontier cuts and ordered pending dump.
**Mechanisms: sessions 1-7, existing owners only. Native image build: no.**

## 6. Evidence limits and final recommendation

No product code, tests, migration, image or dev process was changed or executed.
No QA run id exists for this analysis. The brief asks for no checks beyond
read-only reproduction; no runtime reproduction was necessary to establish
the source wiring, and runtime success is deliberately unclaimed. G-1696's
three assertions remain the first empirical decision gate: if they all already
pass for a genuine active never-approved publication, drop the original
deferred-forever finding and revisit dispatch, rather than implementing this
specification on the strength of reading alone.

The native cleanup admission, lost-response behavior, historical-head validation,
bridge bootstrap over retained events and adoption composition still need their
named tests. Source reading proves available code paths and counterexamples,
not a measured session duration, successful runtime rollout or historical replay.
Missing retained source custody must refuse and be handled by its existing owner;
this report cannot establish every production backup's retained-event inventory.

PostgreSQL's [row-lock documentation](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
supports serializing cursor mutation in a transaction. Apache Jena's
[TDB transaction documentation](https://jena.apache.org/documentation/tdb/tdb_transactions.html)
describes its single-writer transaction model. These primary sources support
the locking model only; REZICS's command policy, journal and exact-owner tests
must prove this composition. Sources consulted 2026-10-11.

**Choose closed by default without default records.** Repair later-approval
delivery, retain proved superseded heads without changing client CAS, clean old
body units inside publication, and use existing verified rebuild coverage for
adoption. Keep integrity checks and capacity; require current-state equality at
a joint stable owner cut. This removes the default profile/term/decision writes,
legacy decision reconciliation, default-result API field, broad approval-caller
migration and exclusion-disposition table. It needs small Content delivery and
capacity migrations, but no new native image build on the evidenced path.
Default decisions still need the same delivery, ordering and rebuild repairs,
and their additional negative authority machinery does not repair a counterexample
that the existing owners cannot handle more directly. Manager sends this
recommendation to Trust-ops for review before the terminal-release milestone.
