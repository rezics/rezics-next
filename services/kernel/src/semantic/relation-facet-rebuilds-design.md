# Imported relation facet source rebuilds

This is an implementation handoff and deliberately failing executable specification. It specifies only asynchronous
source rebuild metadata. It does not settle relation membership, visibility proofs, search snapshots, or point probes.
It does not adopt the publication barrier proposed in `relation-facets-design.md`. Immediate Content `readFences`
suppression continues to apply before, during, and after this relay's catch-up. There is no restore event, permission
API, point-proof cache, signature, or publication barrier in this path.

## Public port and event ownership

Add `relationFacetRebuilds({ pool, routeKey, pageSize? }): Relay` in `relation-facet-rebuilds.ts`.
The consumer is always `semantic_relation_facet_rebuilds`. The default dependency page is 32, maximum 64, minimum 1;
reject fractions and out-of-range values before SQL. `run(partition)` uses `projectBatch` with `envelopes: 1`.
One call processes at most one dependency page, including its source commands. It never recursively catches up a
continuation. The fixed envelope bound and page bound are separate: each registration event contains one change. Imported creation emits one per initial relation candidate, within
the existing bounded input and 1000-event command limits. A registration-only backfill envelope contains at most 64
changes. Work for a source envelope is bounded by its changed candidate count, never existing source degree.

Consume the already registered `com.rezics.content.source_fence.taken_down.v1` at tuple home, with closed data
`{route, source, external_id, field_group, securityRevision}`. The last field is a decimal bigint string, never a JS
number. `field_group` is `facts | summary | cover`. Compute/validate tuple home with `tupleRoute(routeKey, source,
external_id)`; validate envelope partition too. Content owns no subject inverse and needs no change or new hook.
Summary and cover fences do not enumerate fact dependencies.

Register the following closed schemas in `SEMANTIC_EVENTS`, in the emitting implementation change. All identifiers
are canonical routable UUID strings, routes are integers 0..65535, revisions below are positive integers; `security_revision` is a nonnegative decimal bigint string (`^(0|[1-9][0-9]*)$`). The fence
`securityRevision`, which matches `^[1-9][0-9]*$`. Source/external identity limits match Content (32/1024 UTF-8 bytes).

| Event                                             | Exact data                                                                                                   | Envelope subject and partition                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `com.rezics.semantic.facet_dependency.changed.v1` | `{route, source, external_id, field_group, subject, candidate, property, revision, security_revision, live}` | `subject` is the source; source anchor partition           |
| `com.rezics.semantic.facet_rebuild.planned.v1`    | `{route, source, external_id, field_group, securityRevision, after, plan}`                                   | no subject; tuple home                                     |
| `com.rezics.semantic.facet_rebuild.continued.v1`  | `{route, source, external_id, field_group, securityRevision, after}`                                         | no subject; tuple home                                     |
| `com.rezics.semantic.facet_rebuild.completed.v1`  | `{route, source, external_id, field_group, securityRevision, after}`                                         | no subject; tuple home                                     |
| `com.rezics.semantic.facet_dependency.applied.v1` | `{route, source, external_id, field_group, subject, candidate, revision, security_revision}`                 | no subject; tuple home                                     |
| `com.rezics.semantic.facet_rebuild.checked.v1`    | `{cause, subject}`                                                                                           | no subject; source anchor partition; internal no-op result |
| `com.rezics.subject.relation_facet_changed.v1`    | `{route, source, external_id, field_group, securityRevision, cause}`                                         | affected SOURCE UUID; source anchor partition              |

Here `route` always means tuple route; derive the source route from `subject`, never overload tuple route. `after` is
null or the fixed-length cursor `[sourceRoute, subject, candidate]`. `plan` is a deterministic UUID derived from the
complete tuple, fence revision, mode and input identity (defined below). `cause` is exactly
`JSON.stringify([route,source,external_id,field_group,securityRevision,sourceSubject])`, with no whitespace. This is
stable across candidates, pages, retries and envelope IDs. A new monotonic fence revision is a different cause.
No target ID occurs in routing or rebuild data. Do not add statements, qualifiers, references or candidate bodies.

The internal `planned`, `applied`, `completed` and `checked` events satisfy the ordinary executor's nonempty-event
requirement. They are ignored by Search. Replaying an already committed internal command uses its semantic-owned receipt
and emits nothing new. A continuation emitted by completion is the only work token advancing a fence cursor.

## Source command integration

In `bulk.ts:batchCommand`, immediately after `insertSourceCandidate` in the propose branch, append one dependency
change to `written.events` in the SAME source transaction. Extend the existing `visibleSubject` projection to
include `s.security_revision::text` in that same exact subject read; new imported creation uses security revision `'0'`. Existing-candidate/receipt resolution emits no duplicate.
Do this for imported relation candidates, including proposals to arbitrary OTHER subjects. `external_claim` only
identifies the originally tuple-created subject and cannot route such proposals. Do not synchronously write tuple home.

In the retract branch, after `insertRetraction` and `deleteSourceCandidate`, append the same tuple/candidate/property
with `live:false` and the new source revision and current source security revision. Obtain property from the exact candidate read, not a subject-degree
scan. In `subject.ts:writeSubject`, imported initial relation facts also emit registrations with their original
statement UUIDs and creation revision; compact facts must not depend on later slot expansion to become discoverable.
`candidates.ts:writeProposal` is the shared writer but does not alone know bulk deduplication success: attach the bulk
registration only after its inverse source-candidate row succeeds. Native authored proposals emit no tuple registration.

Register all relation properties, even currently nonfacet ones. A declaration may change later. Source dispatch checks
CURRENT subject type/release declaration, not a release cached in a registration. Only `facts` dependencies participate
in this path. Pending, accepted and adopted candidates can conservatively cause a source rebuild; rebuild scheduling
makes no assertion that a candidate is currently a member. Retracted candidates never cause rebuilds.

Existing local events suffice for native changes: `subject.created` in `writeSubject`; `subject.revised` for propose,
accept/reject, Global adoption (including empty suppression) in `candidates.ts`, identity changes in `subject.ts`, and
bulk retraction in `bulk.ts`; `subject.visibility_changed` and statement moderation's subject event in `moderation.ts`;
`subject.merged` in `merges.ts`. Search already sees their source subject. `subject.adopted` is registered but is not
currently emitted; no additional adoption event is needed for this independent rebuild path. There is no native
facet-change gap requiring it. If a definition rollout changes a subject's stored current release, its bounded source command must carry a
`subject.revised` identity event (or this additive rebuild event); merely activating a global release pointer does not
change every existing subject's stored release. Do not enumerate tuple history in a request.

## Owned storage and bounded access

Add a semantic migration and typed SQL, with every statement binding exactly one partition. Tuple relations lead on
`route`, and source relations lead on the source's route. Include explicit partition range guards where required by
placement checking. Never join tuple state to remote source tables in SQL.

- `semantic.facet_dependency_version`: primary key
  `(route,source,external_id,field_group,source_route,subject_id,candidate_id)`; stores highest lexicographic `(source revision, source security revision)`,
  property and `live`. Compare the pair as integer/bigint in SQL, never floating-point JS numbers. This retains tombstones. Equal revisions must have identical payload; mismatches stop the
  consumer instead of choosing an arbitrary winner. Lower version pairs are ignored.
- `semantic.facet_dependency_live`: same primary key, property and revision. Contains only live registrations.
  The complete tuple prefix followed by `(source_route,subject_id,candidate_id)` is the page index. Physically delete
  on retraction; no `LIMIT` over a history table with residual retraction filtering. No additional partial index is
  needed because the entire table is live. An implementation combining these tables MUST provide that exact partial
  btree `WHERE live`, and prove the planner uses it before merging.
- `semantic.facet_fence_progress`: tuple primary key, greatest observed bigint fence revision. Older fence envelopes
  cannot regress it. A newer revision may run independently; each revision has its own cursor work and stable causes.
- `semantic.facet_rebuild_page`: deterministic plan UUID primary key, with unique
  `(tuple,fence revision,mode,input identity)`; mode is `page | registration`, input identity is the page cursor or
  `(source subject,candidate,source revision,security revision)` for late registration; stores a bounded immutable
  plan (at most pageSize dependencies plus one lookahead), next cursor and completion flag. Uniqueness includes page
  size/config generation, fixed for an active fence run. Do not change page size mid-run; new runs use new settings.
- `semantic.facet_rebuild_request`: SOURCE `(route,subject_id,cause)` primary key, fence revision. Exact
  insert/return-existing coalesces accepted requests across candidates/pages. The row and additive subject event commit
  together through `runCommand`. A skipped check commits an internal `checked` event with a receipt keyed by cause,
  candidate/version set and checked subject generation; it MUST NOT reserve the cause in the request table. Another
  live candidate on a later page may still justify that source's rebuild. Only positive requests coalesce by cause.
- `semantic.facet_relay_receipt`: primary key `(route,kind,work_key)`, bounded saved result. `work_key` is SHA-256
  of the canonical work identity (not the potentially 1-KiB external ID used directly as a core receipt key). These
  internal commands have no account principal: do not invent a service account or use anonymous request receipts.
  An actorless `runCommand` wrapper reads this row under the ordinary partition command gate; a prior result throws
  a private already-applied sentinel before any writes, rolls back the read-only attempt, and returns the saved result
  outside the executor. A first application saves its result and emits its internal event atomically. This uses the
  same rollback/early-resolution pattern as bulk's `Resolved`, without changing executor or permission APIs.
- `semantic.facet_rebuild_backfill`: source-partition high-water key, phase and readiness. This is internal worker
  state, not a permission or disclosure readiness gate.

Each registration applies a version compare/upsert and corresponding exact live insert/delete in a tuple-home command.
It reads the existing Content fence once, by complete tuple key. If a live registration finds a committed fence, it
records a one-candidate bounded plan and dispatches the source immediately after committing/releasing tuple home.
This applies even if the registration replay's version is unchanged: the stable source cause prevents duplication.
An old live registration rejected by a newer tombstone must not dispatch anything. Receipt identities include source
anchor, candidate, source revision/security revision and tuple. There is O(changed candidates) indexed work, no tuple/source-degree scan.
The source transaction is already closed before tuple checkout; tuple checkout is closed before source dispatch.

A fence or continuation seeks ONLY the full tuple prefix in `facet_dependency_live`, strictly after the cursor,
`ORDER BY source_route,subject_id,candidate_id LIMIT pageSize+1`. Persist the immutable plan and lookahead in a tuple
command before any downstream work. Keep the lookahead unconsumed; next cursor is the last consumed dependency.
This is at most pageSize+1 examined live rows, regardless of historical retractions. There is no residual facet test
inside this range scan: bounded source checks happen afterwards. Late insertion behind a cursor is covered by the
registration's fence read, so cursors need neither restart nor a global snapshot.

After releasing tuple home, group the page by source partition, then source UUID, and execute bounded source commands.
Each source checks exact subject visibility/redirect, current type and exact definition release (route 0 separately,
no held source transaction across remote checkout), candidate/retraction keys, and property declaration. Cache only
immutable definition releases. Resolve the declaration before source checkout, then verify the source's release still
matches inside its command; retry with the new immutable release if it changed. At most 64 exact source/candidate
checks and 64 source commands per page; no unbounded subject read or slot/history fold. Coalesce duplicate source causes
before commands and again by the request primary key. A page with all nonfacets still advances its cursor.

Finally commit completion at tuple home with a receipt keyed by plan UUID. Emit exactly one continuation if lookahead
exists, otherwise `completed`. Completion occurs AFTER every source result commits. The original projectBatch
checkpoint advances only after completion. `planned` envelopes never redispatch plans by themselves; replay of the
original fence/continuation resumes its saved plan. Semantic receipt/request uniqueness handles a crash between source
commit and tuple completion. Tuple completion uniqueness handles a crash before checkpoint compare-and-set. No
consumer holds a transaction while awaiting another partition. The whole fanout is O(dependents) across durable
steps, never one bounded request.

A new true registration after restore must verify the candidate is still unretracted; candidate UUIDs are never
reused. The pair orders mutable source lifecycle versions, while candidate retraction remains permanent.

Retraction costs one exact version update and live delete per changed candidate. Historical version storage is
O(all candidate changes); it is not visited by fence pages. Plan storage is O(dependents) for each fence run; completed
plans/receipts can be retained with outbox retention or reclaimed only behind a durable consumer replay floor. Version
tombstones can remain forever with O(1) per-candidate storage (only the highest revision). If reclaimed, persist a
source-partition bootstrap floor that rejects older registration/backfill versions first. Never remove the only
anti-resurrection information while old envelopes can replay. Total maintenance is O(registrations + retractions +
sum of fence fanouts), with indexed logarithmic lookup factors. Old tombstones do not add work to later fence pages.

## Lifecycle and deployment

A redirect does not transfer candidate ownership to a survivor. Source commands detect `redirectOf` and skip rebuilding
the old source; merge's ordinary subject event handles its deletion in Search. Do not follow the redirect and invent a
survivor dependency. Deletion/takedown similarly skips a nonvisible/missing source. Existing visibility events handle
its index removal/restoration. Historical live routing for a redirected/deleted source must be cleaned by a separate
bounded keyset sweep, emitting revisioned false registrations. Use the source-owned `source_candidate` prefix `(route,subject_id)` and initial imported candidate metadata
for this sweep, never a cross-partition scan of the tuple inverse; persist the current subject revision/security revision pair with cleanup registrations and reject old registration
at source dispatch immediately. Retraction advances revision, moderation advances security revision, and merge
advances revision. The sweep rereads that pair inside its source command; a concurrent restore retries it rather
than emitting a stale tombstone. A compact imported candidate uses its creation revision until a lifecycle change.
The tuple live page may include such a stale candidate before cleanup, but examines at most pageSize+1, with total
cleanup work charged once per retired dependency. It never scans over these rows to fill a page. Restored subjects get
normal local events and, where required, bounded current registration replay with the current fence cause. A false
candidate tombstone cannot be resurrected by restoration.

New events alone cannot cover committed imports. Deploy storage and writers first, then a restartable backfill before
claiming asynchronous rebuild coverage. Per source partition, record a high-water source_candidate key and cursor over
`(route,subject_id,source,external_id,field_group,statement_digest)`, using its existing primary key. Read at most 64+1
rows per step, exact candidate/proposing revision metadata, emit the same registration versions in source outbox through
ordinary commands, and checkpoint atomically. Concurrent retractions win by higher revision at tuple home. If an old
row vanished before backfill, it needs no live registration; new writes are already dual-recorded. Also keyset-page
preexisting imported creation revisions/compact initial relation facts, with a source/revision index restricted to
imported creation metadata and a bounded fact page, so tuple-created imports are not silently omitted. Never expand
an entire subject's facts while backfilling. Record separate phase cursors, bounds and receipts.

Readiness means every backfill phase is complete and emitted registrations have reached tuple home; persist per-page
acknowledgments instead of assuming an outbox position alone proves cross-partition delivery. This readiness only
reports metadata coverage. Fences still publish immediately. Registration's fence read catches every already-down
tuple, so both event orderings converge without replaying the whole Content history. Keep backfill worker work bounded
and independently schedulable through durable continuation envelopes (register their closed cursor/progress schemas in
the implementation, with no more than 64 registrations per envelope). Do not block HTTP writes or disclosure on it.

Backfill/sweep work tokens are also closed registered semantic schemas:

- `com.rezics.semantic.facet_dependency.backfill.v1`: `{partition, phase, after, high}`; partition 0..4095,
  phase `source_candidate | imported_creation | initial_fact | acknowledge`, after/high null or arrays of at most
  eight bounded strings/integers. Each phase has a fixed key: the source_candidate primary key above; creation
  `(route,subject_id,revision)`; initial facts `(route,subject_id,slot_id,statement_id,log_seq)` within one creation;
  acknowledgments `(source_route,subject,revision,candidate)`. The token and phase select the cursor shape, never
  arbitrary SQL or a caller-chosen table. Epoch/high-water identity is included in the durable worker row.
- `com.rezics.semantic.facet_dependency.retire.v1`: `{subject,revision,security_revision,after}`; after null or
  `[source,external_id,field_group,statement_digest]`, with the same bounded identity strings as registration.
  A separate initial-fact cleanup phase uses the backfill worker's initial-fact cursor. The source owns this token;
  at most 64+1 source metadata rows are read per invocation, and each emitted change has the checked lifecycle pair.

Their envelope partition is the source partition, with no subject on these internal events. Backfill readiness rows
track each output page's acknowledgment count, with exact unique acknowledgment keys; replay cannot increment twice.
These are required implementation schemas, not extra behavior tests of relation membership.

## Search trace and implementation work

`search/indexer.ts:createSubjectIndexer` accepts every `com.rezics.subject.*` event with a subject, rejects foreign
anchors via `subjectPartition`, and deduplicates source UUIDs per batch. The new additive event therefore calls the
existing source snapshot once per distinct source. The source command advances the ordinary partition outbox position; it does not fabricate a semantic revision. Keep its external-version snapshot behavior, `documentActions`,
bulk `refresh=wait_for` and checkpoint-after-bulk ordering unchanged. Target documents receive no event from this path.
No callback into Search internals and no edit to `search-source.ts` is needed for this work.

Implementation-ready paths:

- New `src/semantic/relation-facet-rebuilds.ts`, typed registration/page/plan/request/backfill SQL and focused unit tests.
- `src/semantic/bulk.ts`, its exact candidate metadata SQL, `src/semantic/subject.ts`, and `src/semantic/events.ts`.
- Lifecycle sweep integration in `src/semantic/merges.ts` and `src/semantic/moderation.ts`, with independently durable
  cleanup/backfill continuations; do not turn merge into a source-degree synchronous command.
- A new semantic migration, regenerated `db/semantic/schema.sql`, and placement tests for every statement.
- `src/worker.ts` imports the new Relay beside `linkProjection`; no new HTTP route or permission.
- The two acceptance files alongside this design, backfill/crash/invalid-config tests, native-event coverage tests,
  and worker composition tests. Content and Search production files stay unchanged.

Concrete new files under `services/kernel` for the implementation:

| Path                                                                | Responsibility                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/semantic/relation-facet-rebuilds.ts`                           | Relay, source dispatch, stable causes and page recovery          |
| `src/semantic/relation-facet-backfill.ts`                           | Restartable bootstrap and lifecycle cleanup                      |
| `src/semantic/facet-dependency-apply.sql`                           | Version CAS, physical live upsert/delete, exact tuple fence read |
| `src/semantic/facet-dependency-page.sql`                            | Complete tuple seek, pageSize+1 live rows                        |
| `src/semantic/facet-rebuild-plan.sql`                               | Exact existing plan lookup and immutable plan insertion          |
| `src/semantic/facet-rebuild-complete.sql`                           | Plan completion CAS and monotonic fence progress                 |
| `src/semantic/facet-rebuild-source.sql`                             | Exact subject, redirect, bounded candidate/retraction metadata   |
| `src/semantic/facet-rebuild-request.sql`                            | Source-cause positive insert/return-existing                     |
| `src/semantic/facet-backfill-source-candidates.sql`                 | Source candidate primary-key page                                |
| `src/semantic/facet-backfill-creations.sql`                         | Imported creation partial-index page                             |
| `src/semantic/facet-backfill-initial-facts.sql`                     | One imported creation's bounded fact page                        |
| `src/semantic/facet-backfill-progress.sql`                          | Cursor/readiness and unique acknowledgment updates               |
| `db/semantic/migrations/20261027010000_relation_facet_rebuilds.sql` | Owned tables and indexes                                         |
| `test/semantic/relation-facet-rebuilds-worker.test.ts`              | Composition, crash windows, config and backfill tests            |

The imported-creation index is `(route,subject_id,revision) WHERE kind='create' AND source ? 'source'` on revision.
The initial-fact index is `(route,subject_id,recorded_transaction_id,slot_id,statement_id,log_seq)` restricted to
asserted relation statements. Its equality prefix includes the known imported creation transaction, so no entire
subject scan is needed. Existing file changes are `src/semantic/bulk.ts`, `bulk-read-proposed-source.sql` (include
property), `subject.ts`, `events.ts`, `merges.ts`, `moderation.ts`, `src/worker.ts`, `db/semantic/schema.sql`, and the two
acceptance files. Prefix the listed semantic basenames with `src/semantic/`. Keep typed SQL split further if placement
requires separate statements; each emitted command and read still uses exactly one anchored partition.

Performance handoff for the manager: new hot-path reads are `facet_dependency_version`, `facet_dependency_live`,
`facet_fence_progress`, `facet_rebuild_page`, `facet_rebuild_request`, `facet_relay_receipt`, source lifecycle metadata, exact candidate and
retraction metadata, `semantic.subject`, `semantic.redirect`, `semantic.definition_release`, and existing
`content.source_fences`, plus normal command/receipt/outbox/checkpoint relations. Backfill additionally reads imported
creation/revision/fact keys and its own progress. This is the manager notification for the performance handoff: add these to shared seed fixtures when implementing, including
retired dependency history; never count a mock callback as persisted enqueue work. The current growth specification
seeds through production source writes and records source dispatch inside its single-step capture.

The acceptance files intentionally assert module availability until implementation. They cover cross-partition OTHER
subjects, multiple pages, late registration with direct immediate fence disclosure, real checkpoint rewinds and
continuation replay, nonfacets/retractions/redirects/takedowns, and fixed-page cost at 64/512/4096 with warmup and three
samples. The growth test positions the real consumer immediately before a persisted continuation; only setup and final
whole-fanout verification are outside capture. This is not a measurement of full catch-up.
