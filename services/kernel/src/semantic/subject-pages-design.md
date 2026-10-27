# Subject page feed implementation handoff

This is a proposed implementation handoff, not a declaration that the backend
exists. The public contract is `GET /v1/subject-pages`, anonymously readable,
`limit` 1–1000 (default 20), with exactly
`{subjectPages:[{id,lastModified,labels:[{language,value}]}],next}`.
The acceptance calls `createKernel`; neither a source adapter nor an HTTP
unavailable response satisfies it. Web consumes HTTP and imports no kernel code.
The adopted research mechanism is fixed; the unresolved proof below prevents
claiming that its stronger requirements have a complete bounded implementation.

## Candidate traversal: ready to implement independently

Use the existing `semantic.subject` primary key `(route,subject_id)` as the
candidate index. Candidates include title-only subjects; do not select from an
eligibility-filtered join. The first request visits partition 0. One request
visits exactly one partition, including when that partition is empty.

The proposed `semantic/subject-pages.ts` entry point is
`pageSubjectPages(pool, ring, {size,cursor,access,routeKey,clock,deadline})`.
The HTTP composition call is in `http/kernel.ts`, alongside `subjectRoutes`;
the route belongs in `semantic/http/subjects.ts` or its own route module.
Declare the public exposure and use the existing public permission seam,
`subjectReadEligibility` and Access preparation/final verification, at the
configured authoritative clock. Never manufacture a new subject state or
substitute the editor's grants for anonymous permission. No resources are
created. Keep existing 256 batching and 100-list caps; this feed alone allows
1000 candidates.

In one `withReadTransaction`, read `core.partition` and its epoch, then execute:

```sql
SELECT route, subject_id
FROM semantic.subject
WHERE route >= :partition * 16 AND route < (:partition + 1) * 16
  AND (route, subject_id) > (:after_route, :after_subject)
ORDER BY route, subject_id
LIMIT :limit_plus_one;
```

The extra row is key-only. Disclose at most the first `limit` candidates. If
there is a sentinel, encode the last processed key, not the sentinel key. If
there is no sentinel, the continuation explicitly starts the next partition;
this request does not read it. Partition 4095 exhaustion terminates with null.
An empty partition still consumes one traversal step. Public labels and times
are fetched only for candidates that pass final disclosure; exclusions reveal
neither field. No OFFSET, whole-partition scan, cross-partition SQL join or
scan-until-enough-visible loop is permitted.

Use `tokens/cursor.ts` `encodeCursor`/`decodeCursor`, binding operation
`subject-pages.list` and normalized limit. Proposed position:
`after=[partition,route,subject_id]`; the existing `epoch` belongs to that
partition. For a transition to a new partition, encode a start marker and
resolve its epoch on the next request, rather than querying the next partition
to produce the current page. A start marker needs an explicit validated tagged
encoding (for example `after=[partition,"start"]`); it is never interpreted as
a subject id. Invalid, foreign-binding, expired and stale cursors map through
the existing `PageCursorError` invalid-request route mapping. Preserve existing
partition move handling, rather than treating a moved owner as absent.

## Publication state: proposed local schema, not yet sufficient

New authoritative keys begin with route. The following concrete tables would
support local incremental updates and bounded durable maintenance:

| Table                                | Columns and indexes                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `semantic.subject_publication`       | `route int, subject_id uuid, generation bigint, public_modified_at timestamptz NULL, state text, schema_version int`; PK `(route,subject_id)`; state is `cold`, `building`, `ready` or `missing_evidence`, never a subject visibility state                                          |
| `semantic.subject_public_component`  | `route, subject_id, component_kind text, component_key text COLLATE "C", public_digest bytea, effective_at timestamptz, source_route int NULL, source_key jsonb NULL`; PK `(route,subject_id,component_kind,component_key)`                                                          |
| `semantic.subject_public_change`     | `route, subject_id, source_route, source_position bigint, source_sequence int, component_kind, component_key, effective_at, before_digest, after_digest`; PK `(route,subject_id,source_route,source_position,source_sequence,component_kind,component_key)` for replay deduplication |
| `semantic.subject_public_work`       | `route, subject_id, generation, phase, after_key jsonb, source_position bigint, source_sequence int`; PK `(route,subject_id)`; pending ordered index `(route,subject_id) WHERE phase <> 'done'`                                                                                      |
| `semantic.subject_public_dependency` | `route, source_kind, source_key text COLLATE "C", dependent_route, dependent_subject, component_kind, component_key`; PK `(route,source_kind,source_key,dependent_route,dependent_subject,component_kind,component_key)`; source-route home supports bounded foreign fanout pages    |

The publication row's time records a change of the anonymous representation,
not the maximum time of surviving facts. A local change compares before and
after **public** component digests under the same anonymous disclosure rules.
Only a different public digest adds a public-change record and advances time.
A private proposal or moderation of a never-shown candidate must not advance it.
Removing A at T5 while older B survives records T5, not B's old assertion time.
Restore records T6. Idempotent receipt replay never creates a second transition.
Rebuild compares original change identities/digests, not its execution clock.
Compaction retains the publication watermark and removal evidence before
retiring input history. This is a requirement on future retention, not evidence
that today's retention already guarantees it.

The effective time must be `authoritativeTimeValue(time)` from the originating
command attempt, including the configured kernel clock. It must be stored with
the change at its owner and propagated unchanged across partition boundaries.
An outbox relay's wall time, security revision or checkpoint cannot substitute.
A foreign dependency's removal must remain observable even when that dependency
has already disappeared from the current component set.

## Full anonymous representation and owner coordination

The shared timestamp covers indexed subject views in `docs/subject-pages.md`,
including Overview, Editions, Contents, Characters/Appearances, Credits/Works,
Relations, Reviews, Discussion, Lists and Details. It is not search's bounded
descriptive subset. It excludes personalized library state, own votes, reactions
and private activity that anonymous views do not show.

| Change class              | Public component and required call sites                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Localized identity        | Current visible labels with their stored tags, descriptions, aliases, type/date, structured data and canonical slug inputs; `createSubject`, `writeFacts`, identity edits, definition activation and account-agent synchronization                         |
| Selected fact             | Global slot assertion/retraction, expansion, accept/reject/adopt when it changes actual anonymous output, unresolved/suppressed presentation, qualifiers and sources; `candidates.ts`, `slots.ts`, `write-facts.ts`, bulk commands and semantic moderation |
| Related display           | Displayed related labels, type, date, cover and credited name, property/inverse labels and template labels; `summaries.ts`, definition release changes, `link-keys.ts`/key re-emission and presentation owner                                              |
| Summary and cover         | Public summary text and spoiler-safe output, selected cover, credit/license/caption, media readiness/disclosure, imported tuple fence; authored/imported content and media owners                                                                          |
| Forward and inverse views | Selected preview membership/order, exact or at-least displayed counts, full first-page view output, appearance/cast/credit qualifiers and source/target visibility; `links.ts`, link projection, forward/inverse paging and merge rebuilds                 |
| Public community activity | Public reviews/threads, their rendered previews/counts, public collections and reading orders, visible agent posts and organization membership; content, library, community and presentation owners                                                        |
| Public scores             | Displayed Global score/count/distribution and display threshold, source statistics where shown; rating owner. A vote without a displayed aggregate change is not automatically a page change                                                               |
| Closure/removal/redirect  | Existing resource and operation closure, subject moderation, takedown/erasure, merge/reversal, verified-account redirect and source tuple fences; Access and respective owner commands                                                                     |

Each foreign owner must provide a replayable change identity, original effective
time and before/after public component evidence. The dependency index makes
fanout incremental: one source event creates/resumes a durable cursor; each
command reads at most 256 dependent keys in that source's partition and emits
bounded work for dependent homes. Applying that work touches only exact page and
component keys in one dependent partition. Repeated steps converge over a finite
snapshot followed by catch-up through a captured position. They do not form a
synchronous publication barrier. These are proposed interfaces; production hooks
must be coordinated through the manager with the foreign owners before changes.
No cross-owner production changes are included here.

Labels are current public labels, in deterministic tag order. Do not synthesize
translations, copy a fallback label under another tag, or vary by session or
Accept-Language. Web expands its configured locales using its existing fallback.
Removed/hidden/unknown/unreadable stay 404; API merges stay 308 and web redirects
stay 301. There is no new gone state or 410.

## Blocking bounded-disclosure proof

The schema and bounded maintenance above do **not** prove the required exact
current non-title existence or current publication time under foreign lag.
A bounded positive witness cache is insufficient. This is a concrete conflict
between the requested availability/completeness and the stated cost bound:

1. Let a subject have N independently sourced public relation facts, with
   independent tuple homes. Relation degree is explicitly unbounded; the 512
   descriptive-fact cap does not bound these facts (`semantic/README.md`).
2. Stop consumers. Commit fences at tuple homes; no synchronous cross-partition
   publication barrier or whole-degree source-side fanout is permitted. Thus the
   candidate's local publication row, component index and stored witnesses can
   still be identical to their unfenced state.
3. A fixed dependency budget D checks at most D independent current tuple states.
   Take N > D. Construct two states equal on every probed key and all lagging
   metadata: all probed facts are fenced; an unprobed fact is public in one state
   and fenced in the other. Complete current anonymous existence differs.
4. Returning the entry in both leaks an entry when its last qualifying fact is
   fenced. Omitting it in both violates “if another public fact remains, the
   entry stays.” Continuing until a live witness is found violates the fixed
   dependency budget and prohibition on scanning arbitrary relations.
5. Even a surviving native witness proves only existence. An unprobed foreign
   removal at T5 changes what the page shows. The local metadata and probed
   states cannot distinguish that transition from no removal. Returning an old
   timestamp, B's old time or the relay's later time is explicitly forbidden.

A dependency table does not solve this while its change consumer is paused.
An index over locally eligible witnesses still has stale positives. A tree of
counts/digests needs its relevant ancestors updated synchronously across homes
or inspected through unbounded fanout. Chunking owner queries into batches of
100/256 bounds a statement, not the total request. Scanning fence history from
all partitions likewise moves the unbounded work; a partition epoch mismatch
can detect uncertainty but cannot prove exact page membership/time. Existing
relation facet machinery explicitly returns `not_proven` and schedules bounded
repair when its witnesses are exhausted (`relation-facet-source.test.ts`); that
is safe for its contract but does not establish the stronger feed requirement.

A manager decision is needed on whether unproven publication entries may be
withheld or the request made unavailable until finite repair, or whether a
stronger dependency cardinality/coordination contract is intended. This handoff
does not choose one: temporary omission/503 would weaken the explicit surviving
fact requirement, and a barrier would violate the mechanism. No new external
standard is relevant to this conflict. There is no honest exact bounded
non-title evidence algorithm to hand off under all current requirements.

## Bootstrap and historical evidence

Cold metadata cannot be used as a stale positive. A bounded backfill step would
read at most 256 ordered subject/source history keys plus one key-only sentinel,
store its durable continuation and fold only original public transitions. The
next step resumes strictly after processed keys. Capturing a high-water position
then replaying changes after it gives finite convergence for a finite fixture;
no feed request performs that scan. Warm ready reads must still do current
suppression and cannot rely on readiness for privacy.

There is a separate evidence gap in the current base:

- `semantic.revision` and `semantic.moderation` record transaction ids, not the
  originating authoritative public effective time or public before/after digest.
- `content.source_fences` stores current security revision and taken-down state,
  without the effective removal timestamp.
- `content/source-fence-command.ts` emits tuple identity/security revision but
  does not persist its attempt's domain time in the fence or event data.

An implementation must audit retained command/outbox/write-basis history by exact
transaction/source keys before claiming reconstruction. A database insertion or
outbox recording timestamp is not proof of the configured domain time. If that
original time was never persisted, two executions at different configured clocks
can leave the same retained evidence. Backfill cannot infer which occurred.
Previous removals are required evidence even when the remaining current facts
are old. Preserve missing evidence as `missing_evidence`; do not initialize every
row to deployment time, silently omit `lastModified`, or guess from UUIDs. The
manager must decide the historical-data migration policy when reconstruction
fails. This is an unresolved migration decision, not permission to invent time.

## Acceptance and remaining slices

`test/semantic/subject-pages.test.ts` exercises the real HTTP kernel, shared real
Access/grants and configured clock. It specifies title-only/pending/unselected/
rejected/private-Context exclusion, current moderation/redirect exclusion,
actual localized labels, session/language invariance, T1–T6 transitions, historical
receipt replay, foreign fences without a relay, empty partitions, more than ten
noindex candidate windows, sentinel traversal and limit/tamper/binding checks.
It intentionally expects 200 from the real backend. Missing route/backend is red.

`test/semantic/growth-subject-pages.test.ts` uses shared `checkGrowth`, one warmup
and three measured repetitions at legal scales **[1,8,64]**, 32 rows per unit
(32, 256, 2048), fixed four-candidate requests. It separately grows population
outside the anchor partition, noindex rows inside it, proposal history on the
anchor and relation degree. It seeds real subject/fact/revision/candidate/forward
and inverse relation data. Shared capture accounts for examined and filtered
rows, blocks, statements, catalog queries and background work started by the
operation; no runner costs are subtracted. A missing route cannot masquerade as
constant work. These are requested scales, not a claim of successfully executed
measurements; record actual execution results below.

Ready implementation slices:

1. Candidate cursor and HTTP shell: `semantic/subject-pages.ts`, ordered SQL,
   route registration and schema; reuse token/partition/error/public permission
   helpers. Existing keyset/limit acceptance is the caller-level interface.
2. Local change ledger and effective times: proposed tables above and exact-key
   hooks in semantic commands, with no private-activity clock changes. Clock and
   replay acceptance fixes the interface. Retention must preserve removal time.
3. Foreign owner contracts: manager coordinates the listed call sites, immutable
   change identity and effective timestamp. Each owner can implement bounded
   change/fanout steps independently after the unresolved disclosure policy is
   resolved.
4. Durable bootstrap: explicit phase/key continuations, generation swap, retained
   history verification and missing-evidence reporting. Do not run it inside GET.

Not ready: an exact final-disclosure implementation/proof satisfying the conflict
above; meaningful per-step growth acceptance for an actual publication runner
that does not yet have an agreed viable interface; migration outcomes for data
without original time evidence. Further API cases for resource/operation closure,
owner summary/cover/media, related label changes, inverse views, unchanged import,
rebuild/compaction, and expired/stale/moved cursors remain to be wired to the
resolved owner interfaces. They are requirements, not silently waived tests.

## Verification of this handoff

Root `bun scripts/typecheck.ts` passed. Direct execution against fresh migrated
PostgreSQL databases reached the real HTTP assertion in all four API tests and
the cost test: each received 404 for the absent `/v1/subject-pages` route, rather
than a setup/import failure. This base has no route registration; the brief's
503 stub is not present here. Neither status is accepted as success.

The focused `bun run --cwd services/kernel check
test/semantic/subject-pages.test.ts test/semantic/growth-subject-pages.test.ts`
also completed its preflight checks and reached those same five expected HTTP
404 failures. Only the three declared handoff/acceptance files are changed.

The cost run reached scale 1's population growth and its first warmup, then
failed the HTTP 200 assertion. No measured sample, later scale, other growth
axis, or publication-maintenance bound has passed. The intended legal scales
remain [1,8,64]; there is no measured growth claim for this missing backend.
