# Current outgoing relation facets

This is the acceptance and implementation handoff for unqualified relation facets. It does not implement the
production source. The direct indexed lookup has an unresolved boundedness conflict described below; dispatching
production requires resolving that conflict. Missing production behavior remains an explicit failing assertion.

## Observable contract

A relation facet is a `(property, value)` pair. Role, episode and other qualifiers remain statement metadata and slot
identity inputs; they are not predicates of this port. Unsupported qualified input must be rejected, never stripped
and answered as an unqualified probe.

For each declared outgoing relation facet, `IndexedSubject.statements` contains at most
`MAX_RELATION_FACET_VALUES = 128` distinct visible adopted Global target values. Sampling is deterministic for unchanged
state. Multiple selected statements with the same target contribute one value; a stable representative retains its
qualifier metadata. This avoids treating slot multiplicity as extra facet values. A 129th distinct visible value proves
overflow. `relationFacetOverflow?: string[]` is the shared compatibility field; production always emits a sorted array,
including `[]` when nothing overflows. Nonfacet relations and incoming edges do not contribute. Existing descriptive
facets retain their values and representations exactly.

`RelationFacetProbe = { subject: string; property: string; value: string }` and optional compatibility
`matchRelationFacets(partition, probes): Promise<boolean[]>` are shared with Search; production implements the method.
`MAX_RELATION_FACET_PROBES = 256`. Validate the complete input before data SQL: integer partition in `[0,4095]`, bounded
probe count, valid source UUIDs and matching source partition. Targets may be in another partition. Empty input returns
`[]`; duplicates retain aligned positions. A missing, hidden, taken-down or redirected source cannot match. A pending,
merely accepted, suppressed, retracted, hidden, taken-down or fenced statement cannot witness a match. A different
currently adopted visible statement for the same pair can witness it. Current target visibility also applies.

Each probe must seek the statement store by an index and check current selection, visibility, moderation and source
fences. A Boolean describes existence now, not presence at rebuild time. Incomplete evidence rejects the entire request
as unavailable; neither partial Boolean arrays nor invented absence are allowed. A bounded retry is possible for a
transient failure; permanent unavailability for valid high-degree subjects is not an implementation.

Search must point-recheck every positive candidate before disclosure, including nonoverflow documents. A failed check
drops the hit and refills the page from subsequent candidates. Stable samples and index hits cannot authorize
visibility. Negation uses the index, with overflow absence rechecked through this same probe. A hide before rebuild
may omit a negated hit, failing closed. Index facet counts say `at least`, disclose no subject ids and converge after
rebuild. These Search behaviors and port changes belong to Search, and are not implemented or simulated here.

Rebuilds are asynchronous and refer to changed statements' source subjects. They do not rebuild relation target
documents as a side effect. Existing committed moderation and fence writes already suppress disclosure; there is no
publication barrier, synchronous membership materialization or signature catalogue.

## Existing statement store: exact access paths

The following keys are in `db/semantic/schema.sql`; SQL paths below are relative to `src/semantic/`.

| Evidence                    | Existing key and lookup                                                                                                                                                               | Maximum rows examined once the full key is known                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Source/target status        | `subject_pkey (route,subject_id)`                                                                                                                                                     | 1 per subject                                                         |
| Redirect                    | `redirect_pkey (route,subject_id,sequence)`, descending sequence, `LIMIT 1`                                                                                                           | 1 current row                                                         |
| Compact slot head           | `fact_pkey (route,subject_id,slot_id,log_seq)`, descending log sequence                                                                                                               | 1 head row                                                            |
| Compact candidate payload   | `fact_compact_candidate (route,subject_id,statement_id,log_seq DESC)`, partial on asserted statements                                                                                 | 1 assertion; this alone does not prove it remains selected            |
| Expanded payload            | `candidate_pkey (route,subject_id,candidate_id)`                                                                                                                                      | 1                                                                     |
| Latest Global adoption      | `adoption_pkey (route,subject_id,slot_id,context_id,head)`, Global context and descending head                                                                                        | 1 adoption row; at most 32 selected candidates                        |
| Current verdict             | `acceptance_current_pkey (route,subject_id,context_id,candidate_id)`                                                                                                                  | 1                                                                     |
| Candidate moderation        | `hidden_candidate_pkey (route,subject_id,candidate_id)`                                                                                                                               | 1                                                                     |
| Proposing provenance        | `candidate_pkey` to `revision_pkey (route,subject_id,revision)`                                                                                                                       | 1 each                                                                |
| Compact provenance fallback | `fact_compact_candidate`, then recording transaction via `revision_transaction (recorded_transaction_id,route,subject_id)`                                                            | Latest assertion is bounded; arbitrary historical eligibility is not  |
| Retraction                  | `retraction_pkey (route,subject_id,candidate_id,revision)`, descending revision                                                                                                       | 1 latest row                                                          |
| Local imported dependency   | `source_candidate_pkey (route,subject_id,source,external_id,field_group,statement_digest)`; `source_candidate_retract (route,subject_id,candidate_id,source,external_id,field_group)` | Depends on enumerated dependency keys; neither starts with tuple home |

`GLOBAL_CONTEXT` is `00000000-0000-8000-8000-000000000000`. `item.ts` derives an ordinary relation slot from
source/property/target; a slotKey relation also needs the qualifier key, which is absent from an unqualified probe.
`adoption.selection` is JSON, not an index of target to current selected candidates. `candidate_page` is
`(route,subject_id,slot_id,revision,view_order,candidate_id)` and includes historical proposals. A known candidate lets
`fences.ts:candidateSources` point-read proposing provenance; finding the eligible candidate is the unresolved part.

`content.source_fences` has primary key `(route,source,external_id,field_group)`. `tupleRoute(routeKey,source,external_id)`
locates its home, which can differ from both source and target partitions. `content/source-fences.ts:readFences`
accepts at most 100 tuples per call; `semantic/fences.ts:readAnchoredFences` checks the tuple partition's current state
and then reads the exact tuples. `withoutFencedEntries` uses those current reads. No last-rebuild fence state is an
authority. Chunk known evidence by partition and the existing 100/256 limits, and pass the route key in all production
source compositions. A target is a value, never a foreign source anchor to reject at input validation.

`search-source-facts.sql` currently excludes `fact.relation`, folds all descriptive statement history and identifies
expanded slots. `search-source-adoptions.sql` seeks the latest Global adoption separately for each supplied slot.
`search-source-statements.sql` excludes `candidate.relation` and point-checks `hidden_candidate`.
`search-source.ts:indexedStatement` also excludes nonclassification relation definitions. Removing those exclusions
would enumerate relation degree and history before applying a cap; that is not an indexed bounded implementation.

`outbound_link_pkey` is `(route,subject_id,property,filter_value,order_key,target_subject_id,statement_id)`.
`outbound_link_present` has the same leading fields and includes `slot_id`, with predicate `present`.
`inbound_link_pkey` is `(route,subject_id,property,source_subject_id,statement_id,filter_value)`.
These are asynchronous link projections. Their `present` state cannot prove current adoption or moderation before the
worker runs, and the outbound key's order prefix does not isolate an arbitrary target point. Incoming enumeration is
not a source algorithm.

## Proposed secondary indexes and the boundedness obstruction

A candidate payload expression index could be:

```sql
CREATE INDEX candidate_relation_target ON semantic.candidate
  (route, subject_id, property, (statement #>> '{value,content}'), slot_id, candidate_id)
  WHERE relation AND statement #>> '{value,type}' = 'value';
CREATE INDEX fact_relation_target ON semantic.fact
  (route, subject_id, property, (body #>> '{value,content}'), slot_id, statement_id, log_seq DESC)
  WHERE relation AND kind = 'statement';
```

The point predicates would fix `route`, `subject_id`, `property`, and the main target expression; the snapshot
predicates would fix the first three and order by target. These are proposals, not migrations or sufficient plans.
They cover historical candidates/facts, including unselected or retracted assertions. Even a `DISTINCT ON` or `LIMIT`
above them does not bound examined history. A partial index predicate cannot refer to the latest adoption in another
row or the hidden/fence state in another table or partition. Indexing JSON payloads does not change that restriction.

There is no finite maximum examined row count for these proposals under the approved inputs. The required maxima
are 129 **distinct eligible** values per declared property for a snapshot and a fixed number of statement/evidence rows
per probe, independent of degree/history. Existing indexes only bound evidence after a witness is known. They do not
bound finding the witness or proving no witness exists. No successful production derivation is claimed here.

An exact counterexample, requiring no qualifier filtering:

1. A Book S declares the slotKey relation `ex:credit` as a facet. Create N different keys K1…KN, all with main target T.
   Accept and adopt one candidate Ci per slot in Global. Each candidate has a different imported source tuple Ui.
   All statements and adoptions are valid. Add arbitrary rejected/unselected candidates to those same slots.
2. Commit tuple takedowns for U1…U(N-1), while rebuild and link projection workers remain paused. Leave UN visible.
   The unqualified probe `(S,ex:credit,T)` must return true, using CN. A stale first witness cannot authorize it.
3. In a second state, also commit the takedown for UN. The same probe must return false. These two states differ
   only in one tuple row at its own partition. No synchronous fanout has updated the local candidate/index rows.
4. For any fixed evidence budget B choose N > B, and place the only surviving tuple outside the examined B witnesses.
   Every examined statement/index/evidence row is identical in the two states. The answer differs. Checking the
   remainder examines O(N) tuples/statement witnesses; stopping and returning false invents absence. Returning
   unavailable permanently violates the valid-input contract. Changing index ordering just changes which Ui survives.

Individual candidate hides give the same residual-scan problem through `hidden_candidate`; history creates a further
unbounded scan even without moderation. A known ordinary author slot can point-read its latest adoption, but that does
not solve unqualified slotKey existence or finding 129 distinct currently eligible snapshot values. For snapshots,
N fenced values before 129 visible values defeats a fixed prefix and `LIMIT 129`; N slots for one target also defeats
counting statement rows as distinct values. The snapshot must not silently call an incomplete prefix complete.

The minimum unresolved decision is which requirement can change so arbitrary same-target witnesses with independent
current remote fences admit exact bounded existence and bounded visible sampling. The approved combination of
arbitrary multiplicity, immediate independent fence reads, no synchronous materialization/barrier and fixed examined
rows cannot be implemented by adding secondary indexes to this store. This is a contract conflict, not a request to
restore a prior design. No forbidden replacement is specified as an alternative authority.

## Source-only event and worker handoff

Existing registered event data must remain intact. `events/catalogue.ts` registers `SEMANTIC_EVENTS` and
`CONTENT_EVENTS` at startup and validates them through `events/log.ts:projectBatch`. Relevant existing envelopes are:

| Lifecycle                          | Existing emitting files/events                                                                      | Source rebuild work                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Compact create                     | `subject.ts`, `com.rezics.subject.created.v1`                                                       | Resolve only created source's declared outgoing facets                                              |
| Proposal                           | `candidates.ts`, `com.rezics.statement.proposed.v1`, `com.rezics.subject.revised.v1` kind `propose` | Point-read changed candidate/definition and enqueue source if declared facet, even if still pending |
| Global acceptance/rejection        | `candidates.ts`, `com.rezics.statement.accepted.v1` / `.rejected.v1`, revised `accept` / `reject`   | Check context and addressed property; enqueue source for declared facet                             |
| Adoption/replacement/suppression   | `candidates.ts:adoptCandidates`, revised `adopt`, `LINKS_CHANGED` only when links differ            | Enqueue addressed source; do not infer source from a link target                                    |
| Imported retraction                | `bulk.ts`, `com.rezics.statement.retracted.v1`, revised `retract` (no link delta is emitted here)   | Enqueue changed candidate's source even when no selected contribution remains                       |
| Statement hide/takedown/restore    | `moderation.ts`, `com.rezics.subject.statement_visibility_changed.v1`, link deltas                  | Candidate point identifies property and source; enqueue only declared facet source                  |
| Source subject visibility/redirect | `moderation.ts`, `merges.ts`, subject visibility/merged events and `LINKS_VISIBILITY_CHANGED`       | Existing source document deletion/rebuild; dependent statements must use their source ids           |
| Target visibility                  | `moderation.ts`, link visibility/key continuation events                                            | Page affected dependencies and enqueue their sources; do not enumerate them in a disclosure request |
| Remote tuple fence                 | `content/source-fence-command.ts`, `com.rezics.content.source_fence.taken_down.v1`                  | Page tuple dependencies and route each affected statement source to its own partition               |
| Release facet declaration change   | definitions published/activated events in `events/catalogue.ts`                                     | Page source rebuilds under the new declarations; no claim of immediate index convergence            |

`com.rezics.subject.adopted.v1` is registered in `semantic/events.ts` but is not currently emitted by
`candidates.ts:adoptCandidates`. The generic revised event has no property/context, and a no-op or nonfacet adoption
need not emit a link delta. The production task must emit the already registered adopted event, with its existing
`context`, `property`, `mode`, `revision` and `head` data and source envelope subject. That supplies a bounded classifier
without reverse-scanning adoption history by revision. Keep its existing schema; do not pretend registration alone
is delivery. Retraction must use its candidate-bearing event rather than wait for a nonexistent link delta.

The semantic link constants are in `semantic/events.ts`: `LINKS_CHANGED`, `LINK_KEYS_CHANGED`,
`LINKS_VISIBILITY_CHANGED`, `LINKS_MOVING`, `LINKS_PROJECTED`. `links.ts:linkProjection` uses consumer `semantic_links`;
it maintains asynchronous inbound/outbound state and continuation pages. `worker.ts:startWorker` composes
`work/modules.ts:KERNEL_WORK_MODULES`, launches work, then starts effects and semantic link relays.
`search/work.ts:searchWorkModule` starts `search/runner.ts:startSearchIndexing` only when Search is configured.
`search/indexer.ts:createSubjectIndexer` currently watches all `com.rezics.subject.*` events plus library listing
changes. It neither classifies declared relation facets nor consumes tuple fences, which have no source subject on
the envelope. A generic subject event is not evidence that the missing remote source hook exists. Generic descriptive
indexing remains independently necessary; excluding nonfacet events below concerns the relation-facet rebuild path.

The acceptance proposes this semantic-owned hook, exported from `semantic/search-source.ts` (implementation can live
in a new `semantic/relation-facet-rebuilds.ts`):

```ts
relationFacetRebuilds(options: {
  pool: Pool;
  consumer: string;
  pageSize: number; // 1..64, bounds envelopes and source fanout in one run
  enqueue(partition: number, subjects: readonly string[], cause: string): Promise<void>;
}): Relay;
```

It uses real `projectBatch` checkpoints and bounded durable continuation pages. Enqueue addresses source partitions;
`cause` is stable across replay (envelope identity plus continuation cursor), and the durable queue upserts that key.
Checkpoint advancement follows durable enqueue. Duplicate event delivery cannot create additional logical requests.
The hook classifies nonfacet changes out and never rebuilds target documents because of source relation changes.
Acceptance uses the production semantic source, real protected HTTP writes and real outbox consumption; an absent hook
fails an explicit assertion. Its recording callback observes requests, not semantic answers.

Content peer contract proposal in `src/content/source-fences.ts`:

```ts
type DependentCursor = { partition: number; subject: string; candidate: string };
listSourceStatementDependents(
  pool: Pool,
  tuple: SourceFenceTuple,
  after: DependentCursor | null,
  limit: number, // 1..64
): Promise<{ statements: DependentCursor[]; next: DependentCursor | null }>;
```

Propose `content.source_statement_dependency` with primary key
`(tuple_route,source,external_id,field_group,source_partition,subject_id,candidate_id)` under
`db/content/migrations/`, reflected in `db/content/schema.sql`. Fix the complete tuple prefix, seek strictly after the
last three cursor fields and read at most `limit + 1` routing rows. This provides the per-page maximum of 65 dependency
rows, plus bounded candidate/declaration points per returned source statement. It needs semantic provenance event
emission in `src/semantic/bulk.ts`. Current `source_candidate` starts with subject home and cannot
serve a remote tuple seek across all sources. Preserve or register dependencies through retraction/merge as required
for live candidates; completed retractions need no later fence rebuild. The statement source owner emits bounded
per-statement dependency data in its own committed outbox;
a tuple-home consumer registers that routing index asynchronously and checks an already committed fence when applying
a late registration. This index routes rebuild work only; it does not materialize membership or visibility truth.
There is no cross-partition command waiting for registration. Tuple fanout is asynchronous. A tuple-home dependency
schema/index migration and replay backfill are needed. This is a direct peer proposal for agreement before production dispatch, not a read-time
publication condition. It cannot resolve the existence obstruction above.

All existing event types already have data schemas in `semantic/events.ts`, `content/source-fence-events.ts`,
`content/events.ts` and `events/catalogue.ts`. If a production task emits a new dependency continuation or rebuild
request type, that emitting task must register its schema before use. This specification introduces no production event.

## Bounded implementation tasks after contract resolution

1. Semantic: resolve the store obstruction before adding relation reads to `src/semantic/search-source.ts`. Review
   `search-source-facts.sql`, `search-source-adoptions.sql`, `search-source-statements.sql`, `fences.ts`, `item.ts`,
   `slots.ts`, `context.ts` and `write-facts.ts`. Keep descriptive reads unchanged. Add any agreed secondary indexes
   under `db/semantic/migrations/` and regenerate `db/semantic/schema.sql`; historical payload indexes alone are
   insufficient. Supply EXPLAIN/captured row bounds for the actual eligible-value and existence plans, not just
   returned `LIMIT` counts. Do not ship the illustrative indexes as a purported fix.
2. Semantic/Content: implement the proposed rebuild relay and agreed tuple dependency hook, schema/index migration
   and bounded replay/backfill. Touch `semantic/candidates.ts`, `semantic/bulk.ts`, `semantic/moderation.ts`,
   `semantic/merges.ts`, `semantic/links.ts` only for missing source-event/dependency maintenance. Compose the relay
   through `worker.ts` or a registered work module. Per page, O(changed source ids) rows/statements and logarithmic
   index blocks; total fence fanout remains proportional to affected statements, not constant for the whole run.
3. Search: shared `src/search/source.ts` names/caps/optional compatibility port; source compositions in
   `src/search/work.ts`, `src/server.ts`, `test/search/outcome-driver.ts` and
   `test/search/growth-facets.test.ts` must carry current fence capability.
   Integrate source queue consumption into `src/search/indexer.ts` and `src/search/runner.ts` without duplicating
   source truth. Update `src/search/document.ts`, `src/search/service.ts`,
   `src/search/disclosure/check.ts`, `src/search/facets.ts` and `src/search/query.ts` for capped values, overflow, all-positive
   recheck/refill, overflow negation absence and `at least` counts. Audit `src/search/filter.ts` and filter consumers
   so qualified queries are explicitly unsupported until separately designed. Search owns these edits and tests.
   Other semantic source callers to audit are `test/semantic/search-source.test.ts`,
   `test/semantic/search-source-facets.test.ts`, `test/semantic/growth-search-source.test.ts`,
   `test/semantic/imported-fields.test.ts` and both relation-facet tests. Purely local descriptive fixtures do not
   supply imported provenance; imported fixtures already pass their route key. Preserve that distinction when the
   production source gains its required fence capability.
4. Validation: retain `test/semantic/search-source.test.ts` and descriptive behavior, run both revised relation-facet
   tests, `test/semantic/statement-visibility.test.ts`, `test/semantic/imported-fields.test.ts`,
   `test/semantic/links-projection.test.ts`, `test/content/source-fences.test.ts`,
   `test/content/source-fence-http.test.ts`, `test/content/source-fence-storage.test.ts`, `test/search/relation-facet-port.test.ts`, `test/search/relation-overflow-mapping.test.ts`,
   `test/search/indexing.test.ts`, `test/search/overflow-disclosure.test.ts`, `test/search/overflow-service.test.ts`,
   `test/search/overflow-counts.test.ts`, `test/search/filter-overflow.test.ts`, `test/search/disclosure.test.ts`,
   `test/search/filter.test.ts`, `test/worker-effects.test.ts`, `test/work/worker.test.ts`,
   `test/search/work-imports.test.ts` and root typecheck. New emitting event tests verify catalogue registration and replay.
   No production changes are made by this specification task.

## Executable acceptance and cost measurements

`test/semantic/relation-facet-source.test.ts` covers compact Book author, pending expansion, Global adoption,
suppression/rejection, hide/takedown/restore, incoming/nonfacet exclusion and unchanged descriptive values. It tests
128/129 distinct values and deterministic sampling, a target outside the sample, absent targets, same-target slotKey
statements surviving hidden/fenced alternatives and loss of the last visible witness. No worker runs between indexing
and moderation/fence probes. Real pool exhaustion tests whole-request unavailability. Invalid partitions/anchors,
foreign anchors, 257 probes and unsupported qualified input fail before captured data SQL; cross-partition target
values and empty/duplicate aligned results remain valid.

`relation facet changes and visibility changes rebuild only their source subject` exercises real writes, an owned
outbox consumer, source-only requests and real envelope replay by rewinding only that test's checkpoint. Missing
`relationFacetRebuilds` is an expected red assertion naming the absent hook. Nonfacet proposals and unrelated edits to
an inbound target do not request relation-facet rebuilds.

`relation facet rebuild consumption stays bounded per page as queued changes grow` is the focused per-change/page
cost check in the same source test. Scales `[8,32,128]` grow pending change/history envelopes while `pageSize=1` stays
fixed, with one warmup and three measured samples. Each operation consumes one real envelope. Rows/statements are
constant and blocks logarithmic. This tests per-step work, not whole-fanout completion cost.

`test/semantic/growth-relation-facet-source.test.ts`,
`relation facet source and point probes stay bounded as relation degree grows`, uses shared `checkGrowth` at
`[64,512,4096]`, one warmup and three repetitions per scale. Four independent reports measure snapshot, present outside
the sample, absent (with growing retracted history), and unqualified same-target slotKey membership. Each source starts
with 128 relations before the first scale; scales add degree/history while the returned cap and single-probe input stay
fixed. Distinct authors overflow; many credit slots for one target do not. Fixture facts and real link envelopes are
seeded as in other semantic growth tests; no prefilled membership answers or replacement source are used. Captured
catalogue/background work uses shared classifiers. Projection catch-up during grow is seeding work; any catch-up
triggered by a measured operation remains measured. There are no planner flags or relaxed growth bounds. Shared test
databases use `openGrowthDatabase` and `os.tmpdir()`; task scratch files stay in `.temp/`.

Required source cost is at most 129 visible distinct values per property times the bounded declared facet count,
plus bounded final evidence; required point cost is O(probes) examined statement/evidence rows and O(probes times
index depth) blocks, at most 256 probes. Neither bound currently follows from the statement store for the counterexample.
Expected red tests specify missing source fields/methods/hooks, rather than silently accepting missing production.
