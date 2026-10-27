# Independently testable subject page publication slices

This supplements [the resolved design](subject-pages-design.md); it does not
replace the full feed acceptance. Native publication and repair can be tested
without `GET /v1/subject-pages`, Content changes, Relay delivery or worker mounting.
Passing those tests proves those slices only. Final composition still runs the
unchanged `subject-pages.test.ts` and `growth-subject-pages.test.ts`, including
their HTTP-first checks, mounted runtime accessor and privacy assertions.

## Shared internal contract

`subject-page-publication-store.ts` owns the types and all publication-table SQL.
`subject-page-publication.ts` owns the durable algorithm. Both factories receive
`{ pool: Pool; access: Access; clock: KernelClock; routeKey: Uint8Array }`, with the resolved real Access,
not its factory. They bind native selection, moderation, disclosure and owner
readers internally; neither accepts callbacks supplying publication truth.
Factories are synchronous and do no work until a method is called.
`routeKey` is required and is the same canonical secret already owned by
`createKernel`/the worker; this adds no kernel dependency. Bootstrap derives
`tupleRoute(routeKey, source, external_id)` for retained imported components.
No registry, default, alternate key or guessed canonical secret is allowed.

```ts
type SubjectKey = { route: number; id: string };
type ComponentKind = 'label' | 'fact' | 'cover' | 'relation';
type ComponentKey = { kind: ComponentKind; key: string };
type Witness = { kind: 'fact' | 'cover' | 'relation'; key: string };
type PublicationSnapshot = {
  generation: string;
  readiness: 'cold' | 'repairing' | 'ready';
  publicEffectiveAt: string | null;
  evidence: 'known' | 'missing';
  completedPosition: string;
  witnesses: Witness[];
};
type PublicationEntry = {
  id: string;
  labels: { language: string; value: string }[];
  lastModified?: string;
};
type PublicationStore = {
  read(subject: SubjectKey): Promise<PublicationSnapshot | null>;
  readCurrent(subject: SubjectKey): Promise<PublicationEntry | null>;
};
function createSubjectPagePublicationStore(input: {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  routeKey: Uint8Array;
}): PublicationStore;
function createSubjectPagePublication(input: {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  routeKey: Uint8Array;
}): {
  requestRebuild(subject: SubjectKey): Promise<void>;
  step(options: { limit: number }): Promise<{
    processed: number;
    next: string | null;
    done: boolean;
  }>;
};
function subjectPagePublicationFor(app: object): ReturnType<typeof createSubjectPagePublication>;
```

`read` is a persisted point read, never a repair or recomputation. It returns
null before publication state exists. Decimal strings represent database bigint
positions and generations losslessly. `readCurrent` is the production current
positive-proof adapter, shared by HTTP and focused acceptance. It returns null
when the original gate fails or none of at most eight stored identities proves
a currently shown non-title component. It uses the public reader's actual
predicates, including target disclosure and tuple fences, and rechecks final
disclosure. It never takes the editor's request audience from ambient state. Reuse
`subjectReadEligibility`/`globalReadEligibility`, exact selected-slot predicates
from `slots.ts`, `readCandidateDisclosure`, current fence checks and keyed
`loadRelated` target gates. Factor a shared explicit public audience if needed;
do not call full-degree `readSubject` to prove a witness. Relation hooks use
the located relation slot identity, never enumerate every slot of a property.
It schedules uncertain missing proof through the durable queue; a ready settled
noindex result or missing historical time alone does not enqueue again.
It reads labels with the existing descriptive cap of 512 and owners in batches
of at most 256. Snapshot readiness and witness identities confer no authority.

Component identity is stable: labels use the language tag; fact, cover and
relation keys use the selected candidate/statement UUID, including compact
virtual candidates. A replacement removes the old identity and adds the new
one. Digests cover the public selected value/rank and relevant selection, not
private candidate payloads, private Context state or target-label expansion.
Dependencies include the component kind in their component key encoding
`kind + ':' + key`; a UUID alone cannot collide across kinds. Subject owner keys
are subject UUIDs at `routeOf(id)`; source-fence owner keys use the existing
`fences.ts:fenceKey(sourceTuple(...))` encoding, including route, source,
external ID and field group, at the existing `tupleRoute`. Field-group fences
remain distinct. No new foreign identity namespace is introduced.

The store also exports these transaction-only ports. Types below are internal;
they are not HTTP schemas or an executable task configuration.

```ts
// CommandEvent is the existing type from command/command.ts.
type OwnerKey = { kind: 'subject' | 'source-fence'; route: number; key: string };
type PublicState = { shown: boolean; digest: string | null };
type ComponentTransition = {
  component: ComponentKey;
  before: PublicState;
  after: PublicState;
  dependencies: OwnerKey[];
};
type EvidenceTime = { effectiveAt: string | null; evidence: 'known' | 'missing' };
type RepairPhase = 'bootstrap' | 'descriptive' | 'relations' | 'evidence' | 'replay' | 'done';
type RepairCheckpoint = {
  version: string;
  generation: string;
  phase: RepairPhase;
  sourceKey: string[];
  highWater: string;
  replayPosition: string;
};
function recordSubjectPageTransition(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    changeId: string;
    components: ComponentTransition[];
    outbox: CommandEvent[];
    invalidateGate?: boolean;
  },
): Promise<void>;
function enqueueSubjectPageRepair(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    cause: 'explicit' | 'missing-proof' | 'owner' | 'continuation';
    delivery?: { owner: OwnerKey; changeId: string; eventId: string; time: EvidenceTime };
  },
): Promise<void>;
function commitSubjectPageRepairPage(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    expectedVersion: string;
    checkpoint: RepairCheckpoint;
    components: (ComponentTransition & EvidenceTime)[];
    outbox: CommandEvent[];
    replayedChangeIds: string[];
    witnesses: Witness[];
    complete: boolean;
  },
): Promise<boolean>;
function applySubjectPageOwnerChange(
  tx: CommandTransaction,
  input: {
    owner: OwnerKey;
    changeId: string;
    time: EvidenceTime;
  },
): Promise<void>;
function commitSubjectPageFanoutPage(
  tx: CommandTransaction,
  input: {
    owner: OwnerKey;
    changeId: string;
    expectedVersion: string;
    after: string[];
    subjects: SubjectKey[]; // durable target handoff events, never target writes here
    outbox: CommandEvent[];
    complete: boolean;
  },
): Promise<boolean>;
```

The store additionally exports
`claimSubjectPagePublicationWork(tx: CommandTransaction, input: { partition: number; worker: string;
leaseUntil: string }): Promise<{ kind: 'subject'; subject: SubjectKey;
checkpoint: RepairCheckpoint } | { kind: 'bootstrap'; partition: number;
version: string; after: [number, string] | null } | { kind: 'fanout';
owner: OwnerKey; changeId: string; version: string; after: string[];
time: EvidenceTime } | null>`. This port alone
acquires durable runnable leases using indexed ordered work and `SKIP LOCKED`;
null means no claim in the supplied partition, not global idle while another
live lease remains. Runnable indexes and claims lead with route and are scoped
to that partition. Aggregate readiness visits each of the fixed 4096 partition
homes through bounded metadata, including bootstrap and Relay checkpoints;
there is no global job-table scan, global lease or cross-partition SQL join.

Repair's native source-reader boundary is
`readSubjectPageNativeWindow(client, { subject, phase, after, limit, sentinel })`, where
`phase` is `'descriptive' | 'relations' | 'evidence'`, `after` is `string[]`,
`limit` is the remaining combined budget, and `sentinel: boolean` grants
the still-unused step-wide sentinel allowance. It returns
`{ keys: { sourceKey: string[]; component: ComponentKey }[]; hasMore: boolean }`.
The ordered key window precedes current filtering; the runner advances past
filtered keys and obtains current component state through the existing keyed
native readers. The optional key-only sentinel consumes the step's one shared
sentinel allowance, never a fresh allowance per phase. Bootstrap reuses the
candidate primitive's native source window and commits only through
`commitSubjectPageBootstrapPage`.

Publication replay and owner-home reverse dependencies remain store-owned reads:
`readSubjectPageReplayWindow(client, { subject, after: string, limit: number, sentinel: boolean })`
returns `{ changes: { position: string; changeId: string;
component: ComponentKey | null; before: PublicState; after: PublicState;
time: EvidenceTime }[]; hasMore: boolean }`, and
`readSubjectPageFanoutWindow(client, { owner, after: string[], limit: number, sentinel: boolean })`
reads only `subject_page_owner_dependency` at `owner.route` and returns
`{ edges: { sourceKey: string[]; subject: SubjectKey;
component: ComponentKey }[]; hasMore: boolean }`.
Both use the remaining combined key budget and shared sentinel allowance.
Claimed checkpoint/high-water state comes from the store claim port; replay
and fanout windows cannot mutate it. All component installation, ledger,
publication, lease and checkpoint writes remain exclusively in store ports.
Repair owns phase sequencing and native source SQL, never a second
publication-table writer.

Only the store implements these writers. Callers must already hold the matching
command-partition transaction; ports reject a cross-partition write. Local
`recordSubjectPageTransition` obtains `authoritativeTimeValue(commandTime(tx)!)`
at the live attempt, not `clock()` or a reconstructed revision timestamp. Extend
`updateSubjectIdentity` to accept and forward optional `clock`, as other native
commands already do. The local acceptance advances the clock after real Access
authorization, making a second clock call detectably incorrect.

`changeId` is a stable originating transaction/operation identity; the store
derives per-component ledger IDs from it plus the encoded component identity.
Receipt replay does not enter the mutation body. Duplicate retained evidence or
continuation delivery also cannot append a new transition or advance time.
Equal public before/after state is a no-op. A later proven public transition
establishes a known time even if earlier evidence is missing; replay/rebuild
cannot replace that time with a deployment or worker time. Owner events preserve
their original evidence time through fanout, never semantic consumption time.

## Partition-local dependency delivery

`subject_page_dependency` is subject-home forward state only. Native transitions
atomically persist changed forward keys plus bounded dependency-change outbox
events in the source command transaction. Repair-page installation likewise
emits deltas for only its bounded changed keys. The store owns this SQL and
appends events to the caller-owned `outbox: CommandEvent[]`, which the caller
includes in its existing `runCommand` result `events` before envelope commit; it never opens
owner/target transactions inside a source port.

The separate semantic Relay adapter follows `links.ts:linkProjection`,
`applyLinkBatch`, `newestChanges` and `applyChanges`: `events/log.ts:projectBatch`
reads a source partition, releases its connection, applies idempotent pages
using separate `runCommand` transactions per destination home, then CAS-advances
the source consumer checkpoint. A crash between destination commits and source
checkpoint advancement replays safely. It does not atomically commit source and
destination homes. `events/relays.ts:startRelays` supplies existing lifecycle,
retry and shutdown; no new kernel mechanism is needed.

The native store slice owns the producer schemas in
`semantic/events.ts:SEMANTIC_EVENTS`, already spread into
`events/catalogue.ts:productEventTypes` before catalogue sealing:
`com.rezics.semantic.subject_page.dependencies_changed.v1` carries source
route/subject, component key, owner identity, present/tombstone, source version,
originating event/change identity and original effective time/evidence;
`com.rezics.semantic.subject_page.repair_requested.v1` carries target subject,
owner/change identity and original time/evidence. Arrays are bounded by the
originating changed-key/page budget, packed into bounded array events within
`MAX_COMMAND_EVENTS`; no full-degree payload. Source version is
a monotonic per-source-component dependency version allocated by the store,
not an effective timestamp or delivery order. Each version's owner deltas share
that version, and an event identity fixes its payload. The additive schemas,
producer envelopes and Relay consumers must agree; unknown types must never be
silently skipped.

The store exports `applySubjectPageDependencyDelta(tx, { owner, subject,
component, sourceVersion: string, eventId: string, present: boolean,
time: EvidenceTime, outbox: CommandEvent[] }): Promise<void>`. Its transaction belongs to the owner's
partition. It is the sole writer of `subject_page_owner_dependency`; SQL
compares source versions per full membership key and retains removal tombstones
and event identity, preventing replay/out-of-order resurrection. The row's
`route` equals `owner.route`, not `source_route`. Forward rows are never queried
by a foreign owner. Native owner changes call `applySubjectPageOwnerChange` in
the owner's own command transaction; foreign events enter that port through
separate owner-home Relay commands, preserving the originating identity/time.

`commitSubjectPageFanoutPage` belongs to that same owner home. It advances its
CAS checkpoint and emits bounded repair-request outbox events atomically; its
`subjects` argument describes deliveries, never direct writes to those subject
homes. Relay delivers each event with `enqueueSubjectPageRepair` in a separate
subject-home transaction, then advances its source consumer checkpoint only
after durable target commits. The target deduplicates owner/change/event
identity via store-owned state in its home. Owner delivery supplies the
`enqueueSubjectPageRepair` input `delivery` (required for this cause), retaining
original time/evidence locally; it never reads a foreign publication table. Neither Relay nor repair owns any
publication-table SQL; Relay owns delivery and lifecycle integration only.

An owner change retains its latest original evidence even after fanout completes.
Installing a newer present dependency after the reverse cursor passed (or after
completion) atomically emits a repair request for that membership using retained
owner evidence, alongside the owner-home projection write. Thus late membership
cannot miss an earlier owner change. Replayed/older deltas emit no work, and
finite quiescent source changes plus finite Relay backlog yield finite fanout,
subject repair and checkpoint catch-up. Readiness includes those checkpoints;
current reads always recheck positive proof during lag. Membership arrival itself
never supplies a new publication time, and missing owner evidence stays missing.

## Schema and sole writers

All tables are semantic-owned migrations under `db/semantic/migrations/`.
Use the exact keys in the design, and these column spellings for checkpoints
and diagnostics. Publication SQL belongs exclusively to the store slice;
repair, HTTP and Relay call the store ports rather than writing these tables.
Repair may own `subject-page-publication-phase-*.typed.sql` source readers for
native semantic component windows. Those readers never write or directly read
publication tables. Store SQL and native phase SQL have distinct ownership.

| Table                           | Primary key; other required index                                                                                      | Required state; store writer                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subject_page_publication`      | `(route, subject_id)`                                                                                                  | `generation`, `readiness`, `completed_position`, `public_effective_at` nullable, `evidence`, `witnesses` (maximum eight distinct identities); transition and repair-page ports |
| `subject_page_component`        | `(route, subject_id, component_kind, component_key)`                                                                   | generation, shown state/digest, original effective time/evidence, last change position; transition and repair-page ports                                                       |
| `subject_page_dependency`       | `(route, subject_id, owner_kind, owner_route, owner_key, component_key)`                                               | subject-home forward identities only; transition and repair-page ports                                                                                                         |
| `subject_page_owner_dependency` | PK `(route, owner_kind, owner_key, source_route, source_subject_id, component_key)`                                    | owner-home asynchronous reverse membership, source version/event identity and retained tombstones; store dependency-projection port                                            |
| `subject_page_change`           | `(route, subject_id, position)`; unique `(route, subject_id, change_id)`                                               | component identity, before/after public state, original effective time/evidence; transition port only (repair replays, never reinvents changes)                                |
| `subject_page_repair`           | `(route, subject_id)`; runnable `(route, state, available_at, subject_id)`                                             | `version`, `generation`, `phase`, `source_key`, `high_water`, `replay_position`, `state`, `available_at`, lease; enqueue and repair-page ports                                 |
| `subject_page_fanout`           | `(route, owner_kind, owner_key, change_id)`; runnable `(route, state, available_at, owner_kind, owner_key, change_id)` | original effective time/evidence, version, last reverse key, completion and lease; owner-change and fanout-page ports                                                          |

Use one durable bootstrap checkpoint per source partition, keyed by
`(partition_no)` in `subject_page_bootstrap`, with version, source key, state and
lease. Its sole writer is the store repair-page implementation, extended with
`commitSubjectPageBootstrapPage(tx, { partition: number, expectedVersion: string,
after: [number, string] | null, subjects: SubjectKey[], complete: boolean }):
Promise<boolean>`. Enqueued subjects and the checkpoint commit atomically.
This is continuation metadata, not a new eligibility source or a truth prefill.

Enqueue coalesces without resetting an active pass's phase, source key,
generation or high-water. Terminal explicit/owner invalidation can start a new generation.
Use generation and version CAS on committed pages. Change positions are
subject-local monotonically allocated ledger positions, not the partition's
single command position: one command can change multiple components. Store the
last allocated `change_position` on the publication point so high-water capture
is a point read. A gate invalidation has a ledger entry with nullable component
identity; it is never a positive component or witness. Keep the completed
publication's bounded identities until the generation swap; partially written
component rows do not confer eligibility. Guard component installation against
newer local positions and replay the immutable ledger above the captured
high-water before completion. Original missing-time evidence remains missing.
Retain tombstones and removal evidence. No whole-degree recount occurs in a
local transaction or publication-row update.

## Native mutation audit and bounded hook locations

The hook belongs after the affected current state has been installed, before
the command returns events. Capture public before state for those exact keys
before mutation. Do not place it indiscriminately in `writeFacts`: expansion
and compaction write physical facts without a public transition.

| Native writer                                                                     | Exact bounded hook / exclusion                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject.ts:writeSubject` (also bulk creation and named account agents)           | After private-consent filtering and fact installation: changed labels and selected native facts/cover/relation identities only. Respect the existing 512 write cap. Initialize publication without scanning another subject's degree.                                                                                                                                                                                            |
| `subject.ts:updateSubjectIdentity`                                                | Around `updateIdentity.run`: changed display-language keys and original gate/type invalidation. Existing `holderFacts` is a bounded descriptive read; do not add degree/history reads. Large downstream effects enqueue indexed continuation.                                                                                                                                                                                    |
| `candidates.ts:writeProposal` / `proposeStatement`                                | No shown transition for a proposal, including imported proposals; preserve original source identity for a later selected component. Slot expansion alone has no public effect.                                                                                                                                                                                                                                                   |
| `candidates.ts:decideCandidate`                                                   | Compare the existing before/after Global slot view after acceptance insertion. Acceptance of an unselected candidate is excluded; a decision that changes a currently shown public rank/view is included. Private Context events are excluded.                                                                                                                                                                                   |
| `candidates.ts:adoptCandidates`                                                   | After adoption/current selection insertion: diff the bounded affected Global slot, including replace, suppress/inherit, removals and selected-cover identity. Private Context selection never advances public time. Relation before/after identities use the same bounded slot diff.                                                                                                                                             |
| `moderation.ts:moderateStatement`                                                 | Around hidden-key insertion/deletion: compare the affected candidate's current Global shown state. Count selected hide/takedown/restore, exclude moderation of an unshown proposal. Existing Context link events do not authorize public publication.                                                                                                                                                                            |
| `moderation.ts:moderateSubject`                                                   | After original visibility/security update: invalidate original gate and publish a stable owner change for dependents. Never enumerate all dependent relations in this transaction.                                                                                                                                                                                                                                               |
| `bulk.ts:batchCommand`                                                            | `create` shares `writeSubject`; `propose` shares `writeProposal`; retract after `insertRetraction.run` must diff the exact selected candidate, including selected imported facts/cover. Claim reuse, duplicate source digest and receipt-only `resolve` paths are no-ops. Do not double-record delegated hooks.                                                                                                                  |
| `statement-disclosure.ts:changeStatementDisclosure`                               | After consent disclosure/retraction installation: affected Global sourceOrConsent candidate/slot diff. Already disclosed and prior retraction are no-ops. `keepStatementPrivate` excludes initial private consent facts.                                                                                                                                                                                                         |
| `account-agents.ts:ensureInTransaction`, `syncAgentLabel`, `createUnlabeledAgent` | Named creation delegates `writeSubject`; nameless creation installs cold/noindex state; `syncLabel.run` compares changed/deleted language keys. No duplicate hook in `ensureAccountAgent` wrappers.                                                                                                                                                                                                                              |
| `account-agents.ts:verifyAccountAgent`, `unverifyAccountAgent`                    | Verification delegates the redirect hook; unverify's new node/fact/backlink installation and restoration invalidate exact original identities. Retain the originating verification/unverification command time for continuation, not worker time.                                                                                                                                                                                |
| `merges.ts:mergeSubjectsInCommand`                                                | After redirect/projection-pending insertion: suppress redirected original and record owner invalidation, shared with verified agent merges. Survivor expansion is not recomputed here.                                                                                                                                                                                                                                           |
| `merge-moves.ts:register`, `moveMergePage`, `reverseAccountAgentLinks`            | Retain originating change identity/time in durable move state. At each bounded source/outbound/inbound/member page and survivor apply transaction, invalidate only affected relation/component keys; enqueue publication repair for large effects. Repoint/reversal retains origin time; duplicate expected-cursor pages are no-ops. The existing 100-link move page is not permission to run a 100-key publication repair step. |
| `links.ts` / link projection consumers                                            | Derived outbound/inbound/count/freshness updates are not new domain changes. If they expose a pending shown relation, schedule the affected subject's durable continuation using the originating event identity/time. No publication timestamp from projection application.                                                                                                                                                      |
| `fences.ts` and native reader helpers                                             | Current tuple-fence checks remain authoritative; fence mirrors are not original-time evidence. Semantic foreign invalidation belongs to the durable adapter below.                                                                                                                                                                                                                                                               |
| `context.ts`, `extensions.ts`, definitions activation                             | Private Context creation/default/extension activity is excluded. These are not a second writer for Global subject components. Authored Content installation alone, summaries, graph reads and search projections do not add publication clocks.                                                                                                                                                                                  |

Access closure/revocation is rechecked by the shared current gate without waiting
for any semantic event. No new foreign owner protocol is imposed on Access.
The approved representation does not expand related display labels, summaries,
inverse views or media-owner metadata into publication components. Such a change
would need an explicit contract; selected cover identity itself is included.

## Independent briefs and composition dependencies

Estimates below describe production work, excluding this acceptance handoff.
Each slice owns its listed implementation files; shared store files have one
writer. No permanent stub or temporary success response is a valid landing.

| Slice                                | Paths and estimate                                                                                                                                                                                 | Independent acceptance                                                                                                                                                             | Genuine dependency                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native publication store             | `subject-page-publication-store.ts`, `subject-page-publication-*.sql`, semantic migration, `semantic/events.ts` producer schemas, native mutation files listed above; about 1,100 lines / 20 files | `bun run --cwd services/kernel check test/semantic/subject-page-local-publication.test.ts`                                                                                         | Existing command/Access/read helpers only. No feed route, Content event implementation or repair runtime prerequisite.                                                                                                                                                                 |
| Durable repair/bootstrap             | `subject-page-publication.ts`, native repair phase-window `*.typed.sql` readers (publication-table access only through store ports); about 800 lines / 10 files                                    | `bun run --cwd services/kernel check test/semantic/subject-page-repair.test.ts test/semantic/growth-subject-page-repair.test.ts`                                                   | Store types/ports and current candidate primitive. Direct factory acceptance proves durable unit behavior; it does not prove mounting or worker registration.                                                                                                                          |
| HTTP traversal/current-proof adapter | `semantic/http/subject-pages.ts`, API schema/derived client surface and transport integration; about 350 lines / 5 files                                                                           | `bun run --cwd services/kernel check test/semantic/subject-pages-contract.test.ts test/semantic/subject-page-candidates.test.ts`; final composition also runs full API tests below | Candidate primitive and store interface. It can implement signed traversal, batching, omission scheduling and final current proof without waiting on unrelated worker tests.                                                                                                           |
| Semantic durable Relay/fanout        | `src/semantic/subject-page-publication-relay.ts` and `test/semantic/subject-page-publication-relay.test.ts`; about 450 lines / 6 files                                                             | `bun run --cwd services/kernel check test/semantic/subject-page-publication-relay.test.ts` (new owner acceptance); final API foreign-removal test remains required                 | Content's agreed original-time event and subsequent `SourceFence`/`readFences` extension for real foreign completion. Uses store dependency-projection/owner-change/fanout ports (store slice alone owns their SQL); does not require Content code for native store/repair acceptance. |
| Kernel/worker composition            | `http/kernel.ts`, `worker.ts`, omission scheduler mounting; about 200 lines / 3 files                                                                                                              | `bun run --cwd services/kernel check test/semantic/subject-pages.test.ts test/semantic/growth-subject-pages.test.ts`                                                               | Runtime, HTTP and real foreign adapter. `subjectPagePublicationFor(app)` must return the actual shared mounted instance; worker registration invokes that implementation and durable queue with retry/shutdown.                                                                        |

The repair runner also handles native owner fanout windows through the same
combined step budget and store ports. The Relay adapter supplies durable foreign
event ingestion, deduplication and retry into that machinery; kernel/worker
composition alone owns its lifecycle registration and shutdown callsites.

Content's already agreed original-time slice owns the immutable original
`taken_down_at`/`takedown_id` pair and optional `takenDownAt`/`takedownId` on
`com.rezics.content.source_fence.taken_down.v1` (in `source-fence-events.ts`).
The subsequent internal-read slice extends only `SourceFence` and `readFences`
in `src/content/source-fences.ts` with optional `takenDownAt`/`takedownId`,
absent for legacy, standing and missing fences. It depends on that original-time
slice. The existing cap stays 100 tuples per call (stricter than the general
256-owner cap); one statement per partition, deduplication and independently
owned anchors stay unchanged. There is no `readSourceFences` helper. This is
the exact foreign integration dependency, not a new Content acceptance or
file-ownership assignment. Semantic Relay/fanout consumes the original pair
through the event and bounded current read; neither adapter invents a time. The unchanged
full foreign API fixture is the mandatory final integration dependency, not a
substitute for the isolated native tests. Documentation/web optional-time
adoption remains a separately owned final consumer slice from the design.

## Budget observability and acceptance scope

Every repair source phase materializes a key-only ordered window before current
filtering, in a CTE named `subject_page_source_window_<phase>`. This is an EXPLAIN
observability convention, not a query planner pin. The repair test counts actual
producer rows/loops across all phase statements. For bootstrap it also recognizes
the existing candidate primitive's key-only top-level LIMIT plan, which has no
owner join and needs no SQL change. There are at most the requested limit
(hard maximum 32) examined source/edge keys plus one total key-only sentinel.
`processed` includes filtered keys. Owner point probes are separate and fixed
per key; they cannot hide another source scan. Phase changes never renew budget.
The durable opaque `next` advances on unfinished work; lease waits are not
completion. Idle is exactly `{ processed: 0, next: null, done: true }`.

Focused repair acceptance uses >32 legal descriptive components, filtered keys,
bootstrap without truth prefills, checkpoint reconstruction, enqueue coalescing,
receipt replay, a live public change after high-water capture, and twelve
independent foreign semantic relation targets exceeding D=8. A bounded repair
must find a survivor beyond invalidated cached identities, then settle all-hidden
state and remain idle. Content's tuple-fence removal-time convergence remains
required in final integration; native target fixtures do not claim to prove it.

Growth retains the original legal scales `[1, 8, 64]`, 32 rows per unit, one
warmup, three repetitions, shared default slack and catalog/background accounting.
Other-partition subjects, same-partition noindex, proposal history and relation
degree grow independently. Actual native hide/restore commands, store/current
reads and nonidle repair enqueue/steps are measured, with constant rows/statements
and logarithmic blocks. No planner settings, cost subtraction, truth prefills or
tiny-degree replacement weaken the original full feed/growth acceptance.

Missing factories are dynamically resolved and asserted as behavior failures,
after real migrated-DB native operations. No static missing import or route 404
can stand in for an isolated store/repair test. The full feature still cannot
claim success until the original HTTP-first acceptance passes.

The candidate constants stay default 20 / maximum 1000. HTTP continuation remains
signed, bound to one source partition per step, including filtered candidates
and empty partitions. No cross-partition SQL join is introduced by any slice.
