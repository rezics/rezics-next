# Relation facet witnesses

This is the implementation handoff for the approved unqualified witness contract. The acceptance is deliberately
red until the production source and bounded rebuild runner exist. It introduces no production changes.

A relation facet is a `(property, value)` pair on a declared outgoing relation facet of the source's current type.
Book `schema:author` remains a facet. Incoming relations, undeclared relations and descriptive statements do not
enter this path. Descriptive source behavior stays unchanged. Existing slotKey qualifiers remain stored statement
data. The compatible [qualified credit evidence extension](../search/character-person.md) admits released
item/string qualifier predicates and rechecks each conjunction on one native statement. Qualified variants share
the existing value seek and cursor; absent witnesses remain unknown rather than becoming negative evidence.

## Source and disclosure

`src/search/source.ts` exports `RelationFacetMatch = boolean | "not_proven"` and the aligned
`matchRelationFacets(partition, probes)` result. The compatibility declarations in these tests deliberately use a
local structural view until the production declaration exists; there must be no missing-import/typecheck failure.
The production type is shared by Semantic and Search, not a second independently maintained wire shape.

Per outgoing declared facet the snapshot contains at most 128 distinct visible values and
`relationFacetOverflow: string[]`. Use deterministic property/value index order and inspect the 129th rebuilt value
to set overflow. Statement qualifiers may be retained as stored data; deduplication is by unqualified pair.
Snapshot witnesses are SEMANTIC-INTERNAL metadata. Do not add engine fields, witness IDs to `IndexedSubject`, or
search mappings for them. Snapshot reads recheck current evidence for their bounded sampled hints; they may
underfill while a rebuild is pending, and enqueue repair rather than scanning replacements by degree.

A point probe checks the recorded statement identity first, then at most 32 other statement identities in stable
index order for the same source/property/value, excluding the recorded identity. Without a recorded identity it
may examine at most 32 candidates. A witness counts against this limit even when its adoption, candidate, target
or source tuple is hidden. Candidate history and slotKey multiplicity never enlarge the limit. Validate every
source anchor, routability, partition, and the 256-input cap before acquiring data SQL. Target values can be foreign.
Empty input returns an empty array; duplicates preserve positions and may share bounded work.

Each examination checks current source/target subject visibility, compact or Global adoption eligibility,
candidate moderation/retraction, and imported provenance through `semantic/fences.ts` and Content `readFences`.
Fences only go down and take effect on the next read. A saved witness, completed rebuild, release identity or
queued event never authorizes disclosure without these current checks. An invalid recorded witness cannot return
true merely because it was visible when built.

When no visible witness is found in this budget return `"not_proven"` and commit a source-partition rebuild request.
This includes a bounded range with no witnesses: these tests choose the conservative unproven result rather than
inventing a negative proof cache. Never infer false from an overflowing prefix or a removed/stale hint. Search
must drop and refill this candidate for positive AND negated predicates. Ordinary unproven results are not 503s.
Pool, partition and actual I/O failures still reject the entire call with typed unavailability. There is no truth
or proof cache. This design makes no promise of exact first-call existence beyond the permitted witnesses.

After a completed rebuild, absence from a complete nonoverflow snapshot lets Search's normal snapshot filtering
converge for both signs. An overflow absence still requires the point port and may remain unproven until source
changes/rebuilds remove overflow; Search cannot turn that unknown into a negative hit. The source tests check
snapshot convergence and aligned match results; Search owns actual candidate drop/refill and negation integration.

## Concrete storage and bounded access plans

Add Semantic migrations under `db/semantic/migrations/` and regenerate `db/semantic/schema.sql`:

- `semantic.relation_facet_statement`: an identity/range index of possible compact and expanded statement
  witnesses, keyed by `(route, subject_id, property, value, statement_id)`, with a unique statement identity point
  key within its source. UUID `statement_id` is the compact statement ID or expanded candidate ID. Store the
  exact recording/proposing revision and fact sequence identity needed for provenance points, so checking compact
  evidence never searches its history to discover its source tuple. Maintain
  identities/provenance when statements are written or expanded. It records possible evidence, not visibility or
  pair membership truth. Historical identities can remain until bounded maintenance removes them.
- `semantic.relation_facet_value`: asynchronous internal hints keyed by `(route, subject_id, property, value)`,
  containing `witness_id` and build generation. Store one currently visible witness for each rebuilt distinct pair,
  including pairs outside the 128-value Search sample. Requests seek at most 129 hints per property. The point
  lookup is the complete four-column key, independent of sampled membership.
- A durable Semantic rebuild job/cursor keyed by source route/subject. Track requested generation, active generation,
  `(property, value, statement_id)` cursor, partial pair witness and staged output. A dirty generation cannot be
  lost when another request is coalesced. Keep finite jobs runnable across worker restart.

The candidate range is equality on `(route, subject_id, property, value)` followed by UUID statement ID seek, with
`LIMIT 32`; the recorded identity is excluded without examining extra candidate rows. Point-check adoption and
moderation by their full keys. Do not filter all historical candidates before applying LIMIT. Do not use a
whole-source relation JSON aggregate, offset scan, global/partition scan or recursive historical fold in a request.
Each witness's current evidence is itself bounded; check actual examined plan rows, not only returned rows.

`search-source.ts` imports bound SQL modules for facet hints, witness identity/range probes and evidence checks.
Review `search-source-facts.sql`, `search-source-adoptions.sql`, `search-source-statements.sql`, `item.ts`,
`write-facts.ts`, `slots.ts`, `context.ts` and `fences.ts`. `writeFacts` and expanded candidate paths must maintain the
identity index for real command writes and growth fixtures. Add source event maintenance in `candidates.ts`,
`bulk.ts`, `moderation.ts`, `merges.ts` and `links.ts` only where existing registered events are insufficient.
There is no synchronous membership materialization, publication barrier, qualifier signature or cross-partition lock.

## Event production and finite rebuilds

Register `com.rezics.subject.relation_facet_changed.v1` in `semantic/events.ts` through `events/catalogue.ts` before
any emitting command. An unproven point read uses a bounded source-home `runCommand` to atomically upsert the dirty
job and emit one source-only changed event when a logical request first becomes pending. Its subject is the SOURCE
subject and its partition is that source's partition; it never asks Search to rebuild the target. Duplicate probes,
retries and replay coalesce while the request is pending. A source event and dirty request must be committed before the unproven call resolves. Emit completion/source changed after durable
publication so Search can refill. Distinguish completion from a fresh invalidation to avoid a self-sustaining loop.

Expose only the production `relationFacetRebuilds({ pool, routeKey, consumer, pageSize })` factory from
`semantic/search-source.ts` (its implementation may live in `semantic/relation-facet-rebuilds.ts`). Its runner is
composed by `worker.ts` with the existing relay scheduling lifecycle. `run(partition)` returns
`{ status: "read" | "busy", examined, done }`; one invocation consumes bounded source envelopes and advances at most
`pageSize` witness identities, never a whole job. `done` means the consumer is caught up and its queued generations
are finished, not merely that the current statement page is empty. The examined count is an operational page metric,
not a test-only observer or a source of semantic answers. These tests use pageSize 16 and require resumable progress.

The relay classifies facet source changes and visibility/restoration/new-adoption changes into source rebuilds.
Persist enqueue before checkpoint advancement. Event envelope identity plus source/generation coalesces replay.
An unchanged target edit is not a request to rebuild the target as a relation source. Target visibility dependency
invalidation must route affected SOURCES through the separately owned Semantic routing work.

For each dirty source, read all possible witnesses over durable indexed pages. Evaluate current visibility per
page, retaining a currently visible identity for each pair. Carry a partial pair across page boundaries so a pair
with thousands of hidden slotKey witnesses still reaches its later visible witness. Stage removals and overflow
until the generation's traversal is complete; publish the deterministic rebuilt hints and clear completed dirtiness
with a bounded publication plan. Large output replacement/removal must also be paged, never one unbounded DELETE.

A new mutation during traversal marks a later generation without repeatedly restarting the current cursor. Finish
the active traversal and process the pending generation. Once mutations stop, finite existing work must finish:
no permanent unknown caused by an obsolete pointer, repeated restart, lost dirty flag or starvation. Restarting the
runner must resume its durable cursor. Work is O(all witnesses) over the run and O(page) per step. A fresh read after
publication still checks visibility now; a witness fenced immediately after publication is suppressed immediately.

## Ownership and composition

Tuple-home dependency registration and fence invalidation are a separate approved task. Semantic owns the reverse
routing index. Source commands emit registration in their own outbox; the tuple-home consumer registers it, checks
an already-down fence, and later fences page registered dependencies. Content already emits the registered
`taken_down` event; no new Content hook, table or source-command cross-partition transaction is needed. This task
neither duplicates that task's tests nor retains a Content-owned dependency proposal. Here fencing is followed by
a real unproven probe event and real Semantic witness rebuild. Remote invalidation routing is separate acceptance.

Search already consumes source-only subject events; no engine change is required for their routing. Audit
`search/source.ts`, `search/work.ts`, `server.ts`, `search/indexer.ts`, `search/runner.ts`, `search/service.ts`,
`search/disclosure/check.ts`, `search/facets.ts`, `search/filter.ts` and `search/query.ts` for the shared tri-state port,
overflow, unqualified predicate refusal and positive/negative refill. `search/document.ts` must not acquire witness
fields. Production source constructors retain the route key/current fence capability.

Composition/test call sites are `test/search/outcome-driver.ts`, `test/search/growth-facets.test.ts`,
`test/search/relation-facet-port.test.ts`, `test/search/overflow-disclosure.test.ts`,
`test/search/overflow-service.test.ts`, `test/search/overflow-counts.test.ts`,
`test/search/filter-overflow.test.ts`, `test/search/indexing.test.ts`, `test/search/disclosure.test.ts`,
`test/search/filter.test.ts`, `test/search/relation-overflow-mapping.test.ts`,
`test/search/work-imports.test.ts`, `test/worker-effects.test.ts`, `test/work/worker.test.ts`,
`test/semantic/search-source.test.ts`, `test/semantic/search-source-facets.test.ts`,
`test/semantic/growth-search-source.test.ts`, `test/semantic/imported-fields.test.ts`, and the two tests below.
Other regression
checks include `statement-visibility.test.ts`, `links-projection.test.ts`, and Content source-fence tests. Pure local
fixtures may omit imported provenance, but imported source compositions require the route key.

## Executable acceptance and cost

`test/semantic/relation-facet-source.test.ts` uses the real Semantic source, HTTP kernel and real Access grants.
It retains Book author, compact/expanded Global lifecycle, qualifiers as stored data, descriptive/nonfacet/inbound
exclusion, deterministic 128/129 samples, an omitted positive, current target hide/takedown, imported retraction and
fence checks, invalid/foreign source anchors, foreign target values, 257-input rejection, aligned duplicates/empty
input and actual exhausted-pool typed unavailability. Snapshot helpers explicitly finish background rebuild before
asserting eventual values; immediate point suppression runs without a worker.

`a bounded witness probe suppresses hidden evidence and schedules finite rebuild convergence` builds 40 adopted
slotKey statements for one pair with independent imported source tuples. It reads the actual saved witness, fences
that identity and the next 32 identities in UUID index order while workers are paused, and captures the real source
probe. It requires not_proven, at most 33 witness examinations, a committed coalesced source-only event and no hidden
true or invented false. Restarted bounded pages must record a surviving later witness and the next point probe must
return true. Fencing every survivor suppresses immediately and finite catch-up removes the pair. It runs both a
single-value case and a same-property overflow case with 128 other distinct values. Removal crosses
129 to 128 values and clears overflow without another mutation, allowing positive/negative snapshot convergence. The local recovery acceptance
checks removed-hint restore and adoption, and absence/overflow-negation convergence without a negative proof cache.

`test/semantic/growth-relation-facet-source.test.ts`,
`relation facet source and point probes stay bounded as relation degree grows`, retains FOUR INDEPENDENT reports:
snapshot, present outside sample, absent with retracted history, and same-target slotKey point probes. Each uses
scales `[64,512,4096]`, one warmup and three repetitions. Returned values/probe inputs stay fixed while degree AND
history grow. Shared `checkGrowth` requires constant examined rows/statements and logarithmic blocks. Growth seeding
uses real compact facts, writeFacts, source events and link projection, then real witness catch-up. No prefilled
membership hints, fake source, relaxed growth thresholds or planner flags are allowed.

`relation facet witness rebuild stays bounded per durable page as degree and history grow` in the SAME growth file
uses `[64,512,4096]`, one warmup, three repetitions and fixed pageSize 16. Every measured operation is one production
step, including relay/catalogue/background accounting. Remaining pages are individually captured and bounded and the
run must finish with a useful snapshot and visible witness. Total background work may grow with degree/history;
constant whole-run cost is neither claimed nor required. Shared catalogue/background classifiers remain enabled.
Test DBs use `openGrowthDatabase` and shared OS tmpdir; task scratch files stay in `.temp/`.

Costs: snapshots touch bounded declared metadata, at most 129 hints/property and current evidence for their sampled
witnesses; probes touch one recorded plus at most 32 alternative identities and bounded evidence plus one coalesced
source request. Both request bounds are independent of degree/history with logarithmic index blocks. Rebuild steps
touch at most pageSize identities plus bounded cursor/output/event work, with finite O(all witnesses) total.

Run the two focused tests with the kernel check command and root `bun scripts/typecheck.ts`. Expected reds identify
missing source relation facets, matchRelationFacets and relationFacetRebuilds through explicit availability/value
assertions; new symbols are not statically imported before implementation. Root typecheck must still pass. This
specification does not implement the product source, migrations, runner or Search integration.

Specification validation executed the focused kernel check: 12 intentional red tests (10 source, two growth), all at
explicit availability assertions for `matchRelationFacets` or `relationFacetRebuilds`. There were no import or type
failures. Root `bun scripts/typecheck.ts` passed. The growth tests were invoked but cannot produce measured scale
reports until those production surfaces exist; no numerical cost result is claimed by this specification.
