# Subject page feed implementation handoff

This is the resolved implementation contract. It specifies production work for
independent owning tasks; this change supplies acceptance and design only.
The subject candidate primitive is an independent input, not a prerequisite for
writing this specification. The research recommendation is background evidence;
its former non-null time and immediate foreign completeness suggestions do not
apply here.

## Public contract and candidate traversal

`GET /v1/subject-pages` returns exactly:

```ts
{
  subjectPages: {
    id: string;
    labels: { language: string; value: string }[];
    lastModified?: string;
  }[];
  next: string | null;
}
```

Present times are UTC ISO 8601 strings. Missing historical evidence means the
property is absent, never null or a deployment/worker timestamp. Return actual
public display labels, sorted by language, independently of credentials or
Accept-Language. Global-public readability, no closure/removal/merge redirect,
and current positive evidence beyond labels are necessary for every entry.
An adopted public fact, selected public cover or shown relation can qualify;
unselected proposals, private Context state and labels alone cannot.

Use the existing `subjectPage` candidate primitive when its owning task lands.
Its source step is one partition, ordered by `(route, subject_id)`, with
`limit` candidate rows materialized before disclosure and one key-only sentinel.
Default limit is 20; maximum is 1000. Use the accounts signed-cursor helper;
bind purpose, version, source partition, last processed key and limit, including
its existing expired/stale/moved error rules. Do not consume the sentinel.
The continuation advances after the last processed candidate even when every
candidate is omitted. An empty partition advances exactly one partition;
no request searches subsequent partitions to fill output. Return null only at
the terminal source step. No eligible-result LIMIT or OFFSET traversal.

The full public service, global traversal, current disclosure, meaningful time
and durable repair remain required after the candidate primitive lands. HTTP
transport/schema and owning documentation adoption can land independently.

## Bounded disclosure and the resolved impossibility boundary

With N independent foreign witnesses and consumers stopped, D fixed probes
cannot distinguish a hidden survivor outside the probes from no survivor.
They also cannot discover every original removal time. Exact immediate
foreign completeness/time would require unbounded reads or a cross-home barrier.
Neither is part of this design. The resolution permits temporary omission and
known-time lag, followed by finite convergence under quiescence.

Never infer inclusion from stale eligibility, counts, revision counters or
readiness. For each candidate, immediately recheck the original subject's
Global-public Access/read gate, closure, removal and merge state. Read its
current public labels through the same bounded label disclosure rules. Probe
at most D=8 stored positive witness identities against current authoritative
selection, fact moderation and dependent owner state. A relation witness must
pass the current target disclosure checks; imported evidence must pass its
current tuple fence. Batch owners within their existing 256-id maximum, not 1000. These checks must be the public reader's predicates, not a second weaker
approximation. Recheck final disclosure immediately before serializing; a
concurrent revocation is handled by the existing reader consistency boundary.

The label/descriptive read is capped at the existing 512 descriptive facts per
subject. D bounds relation/foreign witness attempts, independently of degree;
each attempt has a fixed set of keyed selection/owner reads. No full-degree
HTTP read, target-label traversal, historical scan or repair loop occurs in GET.
A 1000-candidate request uses fixed-size batches; it does not enlarge owner
limits. SQL must materialize candidate and witness key windows before joins
that filter current state. Include filtered rows and all owner work in costs.

If no probed witness proves a currently shown non-title fact, omit and upsert
one durable repair job. A cold row may be included only after the same current
proof; unknown time does not make a proven entry ineligible. A surviving native
witness may keep an entry visible while a foreign removal time lags. In every
case original subject/Access/fence suppression is immediate. Uncertainty is
neither permanent absence nor ordinary perpetual 503. Settled noindex results
are not requeued by every read. Foreign invalidation/rebuild starts a new finite
pass; unchanged repeated reads of settled state produce no endless jobs.

## Publication schema and indexes

Implement these semantic-owned tables (names are the handoff, not existing DDL):

| Table                               | Key/index                                                                                                                                                           | Stored meaning                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic.subject_page_publication` | PK `(route, subject_id)`                                                                                                                                            | generation, readiness (`cold`, `repairing`, `ready`), last completed change position, nullable internal `public_effective_at`, known/missing evidence flag, bounded witness slots |
| `semantic.subject_page_component`   | PK `(route, subject_id, component_kind, component_key)`                                                                                                             | last proven shown state/digest and original effective time for a fact, label, selected cover or shown relation; retained removals/tombstones                                      |
| `semantic.subject_page_dependency`  | PK `(route, subject_id, owner_kind, owner_route, owner_key, component_key)`; reverse index `(owner_kind, owner_route, owner_key, route, subject_id, component_key)` | exact dependency identity for incremental invalidation and bounded fanout                                                                                                         |
| `semantic.subject_page_change`      | PK `(route, subject_id, position)`; unique `(route, subject_id, change_id)`                                                                                         | immutable public transition identity, component identity, before/after evidence and original `effective_at`; no private payload                                                   |
| `semantic.subject_page_repair`      | PK `(route, subject_id)`; runnable index `(state, available_at, route, subject_id)`                                                                                 | generation, phase, source key, high-water/replay position, durable repair continuation and lease                                                                                  |
| `semantic.subject_page_fanout`      | PK `(owner_kind, owner_route, owner_key, change_id)`                                                                                                                | original effective time, last reverse-dependency key and durable completion state                                                                                                 |

Witness slots contain at most eight component identities, not copied truth.
Store component history and dependencies outside the constant-size publication
row. A generation swap exposes a completed projection; every HTTP inclusion
still needs current proof. Exact-key lookup indexes serve original gates,
component state and owner checks. Reverse fanout uses ordered key windows, never
all dependents in one transaction. The source candidate index remains the
candidate primitive's authority; publication rows do not replace traversal.

## Local mutation and effective-time hooks

Within the admitted semantic write transaction, maintain components,
dependencies, witnesses and the public change ledger for the affected bounded
local component. Use the command's effective domain time and stable change id.
Do this for create, public display-label edits, Global adoption/replacement/
retraction, shown-fact hide/restore, selected-cover changes, and shown relation
insert/remove/change. Subject hide/takedown/close/merge and restoration also
invalidate current publication eligibility. A large relation operation emits
bounded continuation work rather than recomputing a whole-degree digest.

Compare public before/after state for the affected component. Proposal,
acceptance without selection, private Context activity, moderation of an
unshown proposal, unchanged imports, replay, rebuild and compaction do not
advance time. A shown removal is a change even if only older evidence survives.
T1 create, T4 public replacement, T5 shown removal and T6 restore therefore
remain exact local assertions. Receipt replay retains its original result and
cannot manufacture another transition. Use original public effective times,
never private revisions, security counters, transaction insertion time or
worker clocks. Merge survivor updates follow the actual shown changes.

Maintain the maximum proven meaningful effective time, including tombstones,
not the maximum time of surviving facts. Relay reordering/deduplication cannot
move it backward or advance it to delivery time. An unknown legacy baseline
stays unknown until a proven new public change supplies an effective time;
subsequent replay/rebuild preserves that established time.

## Foreign catch-up and production integration

The approved shared time covers semantic facts the public subject page shows:
adopted facts, public labels, selected cover and shown relations. Imported tuple
fence suppression/removal time is the required foreign case. Persist its
original effective time and immutable change identity at the source-fence
command boundary (`content/source-fence-command.ts` / `content.source_fences`
and its emitted change), then preserve those fields through Relay. Do not
derive time from security revision. This is an explicit owner implementation
slice, not a claim that the current fence schema already retains that evidence.

Relay delivery records the change and a durable fanout continuation in its
existing outbox-consumer/checkpoint transaction. Advance the Relay checkpoint
only with that durable handoff. The worker expands at most 32 reverse dependency
keys per step, enqueues/coalesces subject repair and resumes after the last key.
Replay uses the unique change id. No synchronous publication barrier or
whole-degree fanout is required at the foreign owner.

`src/semantic/subject-page-publication.ts` exports
`createSubjectPagePublication({ pool, access, clock })`: the kernel database
pool, its resolved real Access instance, and `clock: () => Date`. Bind existing
current-reader dependencies internally; callers cannot supply witness answers.
The factory returns the runner interface below. Its production runtime is constructed and mounted by `createKernel`, shared with
the feed's omission scheduler, and obtained for tests through exported
`subjectPagePublicationFor(app)`. That accessor returns the mounted instance;
it must not manufacture a dormant test instance. `src/worker.ts` invokes the
same runtime implementation and durable queue through the existing worker
lifecycle. Wire the source-fence Relay adapter into that lifecycle, including
bounded fanout, retry and shutdown; no GET-triggered in-memory background scan.
These are required implementation seams, not claims of present backend code.

Exact public runner interface:

```ts
requestRebuild(subject: { route: number; id: string }): Promise<void>;
step(options: { limit: number }): Promise<{
  processed: number; next: string | null; done: boolean;
}>;
```

`requestRebuild` durably coalesces work without resetting an active pass.
`step` is the real production bootstrap/repair/catch-up entrypoint, with a hard
maximum of 32 source records or dependency edges across all its phases combined
plus one key-only sentinel. A key may cause only a fixed number of exact owner
reads/writes; owner queries still honor 256-id batches. `processed` counts all
examined keys, including filtered keys; it is not merely emitted updates.
`next` is an opaque durable progress position, advances on every unfinished
step, and is null exactly when `done`. Idle returns exactly
`{ processed: 0, next: null, done: true }`. A short page may finish a phase;
phase switching cannot reset the per-step budget. A worker crash resumes from
the committed checkpoint. Do not mark a lease wait or retry as completed work.

Foreign media resource/publication metadata, summaries, inverse views, related
subject display-label expansion and any additional page/view owner dependency
need explicit enumeration and manager agreement before production if they
contribute to the representation. They are not approved obligations inherited
from the former broad proposal table. Semantic selected-cover identity is in
scope; a new media-owner content clock is not implicitly in scope. The owning
page implementation must reconcile its shown representation against this list.

## Bootstrap, repair and historical evidence

Bootstrap enumerates one candidate partition window using the candidate
primitive, enqueues bounded subject work and persists the partition/key. Per
subject, capture a change high-water position; scan current descriptive and
relation component keys in windows of at most 32, checking each current owner.
Build the next generation's components/dependencies and a bounded set of live
witness identities. Inspect retained public-change evidence by indexed original
transaction/source keys in separate bounded phases. Fold removal transitions
and replay changes after the captured position before completing the generation.
Persist phase, source key, generation and high-water in every checkpoint.
No scan runs in GET. Each phase consumes finite ordered input under quiescence;
each source key advances even when invalid, private or missing evidence.
Every repair page rechecks the original subject gate as well as its current
component/owner keys; a rebuild request alone is not evidence of readability.

Readiness proves only that a finite projection pass completed, not current
privacy. A witness found in a completed pass is rechecked now. If the cached
set is fenced, a fresh bounded pass can discover a survivor beyond D and
replace it. GET omission enqueues repair automatically; explicit rebuild also
catches foreign changes whose notifications have not yet arrived. Production
Relay catch-up ensures lagging known times eventually correct even when a
surviving cached witness kept the entry visible. Unknown legacy time alone
must not cause repeated repair or block a proven eligible entry forever.

`semantic.revision` and moderation transaction ids, and historical fence
security counters, do not by themselves prove original effective times.
Audit retained command/outbox evidence by exact keys. If a time was never
persisted, preserve missing evidence internally and omit `lastModified` in
JSON. Never claim complete original history. Rebuild may recover retained
original times but cannot invent them. The next proven shown public change
establishes time; a proposal does not. Current eligibility proof and timestamp
completeness are independent. Unknown positive proof schedules finite work;
unknown time after completed evidence audit is a settled output state.

A completed pass under quiescence must restore every eligible subject, correct
known foreign removal times, and settle title-only/closed subjects as omitted.
Repeated reads/rebuilds with no public change retain exactly the same output
and time; completed jobs do not spontaneously reschedule. Retry/lease recovery
may replay work but cannot create a perpetual no-progress job chain.

## Acceptance and independent remaining slices

The two acceptance files retain real `createKernel`, Access/grants and domain
clock fixtures, current privacy, real display labels, keysets and growth limits.
Tests first assert actual HTTP 200, then dynamically resolve the production
factory/accessor. Missing implementation is an HTTP assertion failure, never a
static-import failure or a skip. Factory existence alone is insufficient: all
repair calls use the runtime mounted by the real kernel, not a manually created
factory. No witness/publication truth is prefilled. Legal old subject/fact/
revision rows deliberately have no retained command time.

Foreign no-relay tests allow omission or a still-known older time while lagging,
but require current positive evidence for every inclusion. They drive the real
runner in bounded pages, require finite survivor return with the original
removal time and immediate last-witness omission. Ten independent foreign
witnesses exceed D=8. Completed quiescent reads and idle worker checks prevent
endless repair. Unknown-time old rows return with the exact field absent;
private/unshown proposal and rebuild preserve absence, then a shown change
establishes its true time. Local T1–T6 and receipt replay stay exact.

Growth uses the shared `checkGrowth` accounting, unchanged scales [1,8,64],
32 rows per unit, one warmup, three repetitions and four-candidate GETs. Run
feed and real repair measurements separately against fresh owned databases at
those same scales: other-partition population, same-partition noindex, proposal
history and relation degree. Each repair sample includes enqueue and a real
nonidle bounded step. Retain constant rows/statements and logarithmic blocks,
the shared harness slack, catalog/background accounting and actual owner-check
work; subtract nothing. After repair, the preexisting anchor returns without a
time field and repeated reads settle. 404/503 is never a passing cost sample.

Ready independent implementation slices:

1. Candidate primitive: the separately owned `subjectPage` source read and its
   key-only sentinel. The full service still owns global signed continuation.
2. Publication schema, local effective-time/component hooks and current bounded
   witness reader. Export the production factory/runtime interface above.
3. Durable bootstrap/repair worker and kernel mounting/omission scheduler;
   wire bounded phases, replay and quiescent completion to the real worker.
4. Source-fence effective-time persistence and Relay/fanout adapter. Preserve
   original removal time through durable handoff without expanding owner scope.
5. Public HTTP/schema transport and full traversal integration, using the source
   primitive and publication runtime, with immediate final disclosure.
6. Owning documentation adoption and web sitemap consumer of optional time.

Slices can be implemented independently against these interfaces. Production
acceptance requires their combined behavior. No change in this specification
task implements product code, changes shared docs/callsites or waits for them.

## Verification

Root `bun scripts/typecheck.ts` passed. The focused command
`bun run --cwd services/kernel check test/semantic/subject-pages.test.ts test/semantic/growth-subject-pages.test.ts`
completed its preflight and ran both files against migrated PostgreSQL. It
returned exit 1: six API tests and the growth test each reached their real
HTTP 200 assertion and received 404 for the absent feed route. The existing
base handoff recorded the same missing-backend failure for the original cases.
The two new cases also fail at HTTP availability before resolving the proposed
factory or writing their new fixtures. No static missing-module failure or
skip substitutes for the backend assertion.

No growth warmup or measured sample completed, and no repair implementation was
loaded. Thus none of the legal scales, owner-check bounds, runner pages or new
legacy fixtures is claimed to have passed against production. They are runnable
acceptance for the independent implementation slices, with honest expected reds
until those slices land. Only the three declared specification/test files are
changed; execution logs are temporary files under `.temp/`.
