# Relation facet source access

This is a proposed implementation derivation and executable acceptance specification, not a claim that the current
source implements relation facets. The current `search-source-facts.sql` and `search-source-statements.sql` explicitly
exclude relations. Removing those predicates would introduce a degree/history scan and does not implement this design.
The agreed Search port and its overflow behavior remain unchanged.

A source's declared relation facets contribute adopted Global outgoing statements to `IndexedSubject.statements`.
Book author remains `schema:author`. Nonfacet relations and incoming edges contribute nothing. Descriptive statements
keep their existing representation. Relation entries have `facet: { kind: 'item' }` and the adopted statement's admitted
item qualifiers. Sample entries represent statements, including distinct slotKey statements with the same main value;
qualifiers from separate statements are never combined. The per-property cap is 128 entries, not 128 distinct targets.
`relationFacetOverflow` is always emitted, with `[]` when no property overflows; its order has no semantic meaning.

## Required materialization and publication contract

A current-state membership projection is necessary. An index on `(subject, property, target, slot)` alone cannot
answer a qualified existential query: all slots for the same target may fail the last qualifier. A `LIMIT 1` after
that residual test still scans unbounded rows. Nor can a single cached witness plus a final fence check answer exactly:
that witness can become fenced while another qualifying statement remains disclosable.

This design therefore requires **synchronous current membership maintenance and a disclosure publication barrier**.
These are implementation prerequisites, not restrictions on admitted facets or changes to qualifier semantics.
An asynchronously maintained outbound-link projection is candidate evidence only and cannot supply an exact negative.
No release digest, subject digest, outbox checkpoint or stable sample substitutes for final disclosure checks.

The barrier extends the existing imported-source fence/moderation lifecycle. Before publishing a change that makes
existing membership evidence invalid, mark its dependency generation pending, prevent admission of new contributions
under that generation, and drain affected membership updates through independently anchored source-partition commands.
Publish the new gate state and generation only when every affected source partition acknowledges. Reads encountering
a pending dependency or incomplete local projection reject with the existing unavailable/retry path; they do not return
a fabricated Boolean. Recovery resumes the durable drain before publication; retries use dependency generation and
statement identity as idempotency keys. A crash cannot expose old membership under a completed new generation.

This is an explicit cost tradeoff: a fence affecting D statements has O(D times bounded signature fanout) maintenance
work and may delay availability. It does not have constant total write cost. Source reads and point probes retain their
bounds. Retaining immediately published remote fences, allowing arbitrarily stale membership, requiring exact Booleans
without retries, and forbidding dependency maintenance would be incompatible requirements. A final check on one stale
witness cannot solve that variant. Alternatives are a publication barrier as specified here, synchronous distributed
membership updates, or a changed read contract permitting indeterminate results. The tests require completed writes to
be observed and do not require stale evidence to produce a Boolean during an incomplete publication.

Every SQL statement binds exactly one partition, with `route >= partition * 16 AND route < (partition + 1) * 16` in
addition to equality on the full route key. Remote disclosure evidence is grouped by its independently validated route
and read in separately anchored statements. There is no cross-partition SQL join or transaction holding source locks
while waiting for a remote partition. Read gate generations before and after local evidence; require equal completed
generations, otherwise retry within the request deadline or report unavailable. This also prevents a read assembled
across two incompatible publication generations. Restores use the same protocol, with no prematurely positive member.

## Current tables and proposed indexed paths

Existing authorities are `semantic.subject` (visibility/security revision/current release), `semantic.fact` (compact
assert/retract/expand log), `semantic.candidate`, `semantic.acceptance_current`, `semantic.adoption`,
`semantic.hidden_candidate`, `semantic.redirect`, `semantic.revision` (including imported proposing provenance),
`semantic.definition_release`, and `content.source_fences`. Definition reads use route 0 and exact release digest.
Candidate provenance must be copied into current state at proposal/compact creation; probing revision or fact history
to rediscover it is not a bounded read path. The existing historical tables remain the replay authorities.

The following proposed tables are partitioned by the source route, except the explicitly routed dependency catalogue.
All listed keys are B-tree keys with bytewise canonical text ordering. Index-only access is optional: the proof also
allows one bounded heap fetch for each returned index tuple. History never accumulates in these current tables.

| Proposed table/index                               | Leading key and predicate                                                                    | Examined current rows                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `semantic.relation_facet_slot` primary key         | `(route, subject_id, slot_id)`                                                               | One per changed slot; holds current Global selection, eligibility generation and candidate ids |
| `semantic.relation_facet_entry` primary key        | `(route, subject_id, candidate_id)`                                                          | One selected statement payload, slot, value, release, rank, source tuple and generations       |
| `relation_facet_sample` partial index on entry     | `(route, subject_id, property, slot_id, candidate_id) WHERE adopted AND locally_disclosable` | At most 129 per declared facet; no residual eligibility scan                                   |
| `semantic.relation_facet_member` primary key       | `(route, subject_id, property, value, signature)`                                            | Zero or one aggregate count and witness per exact signature point                              |
| `semantic.relation_facet_contribution` primary key | `(route, subject_id, property, value, signature, candidate_id)`                              | One per statement/signature delta; only live eligible contributions exist                      |
| `relation_facet_contribution_by_candidate`         | `(route, subject_id, candidate_id, signature)`                                               | At most the bounded signature fanout for a changed statement                                   |
| `semantic.relation_facet_dependency` primary key   | `(route, dependency_kind, dependency_id, source_route, subject_id, candidate_id)`            | Keyset pages of affected statements at the dependency's home; write/drain path only            |
| `semantic.relation_facet_gate` primary key         | `(route, dependency_kind, dependency_id)`                                                    | One completed generation/pending flag per referenced disclosure dependency                     |

`relation_facet_member` stores a count and one live witness, not an array of all members. On witness deletion, the
contribution primary key supports a successor `ORDER BY candidate_id LIMIT 1` using the complete signature prefix.
It does not scan tombstones: deleted contributions are removed. Counts, witness and entries change in the same source
transaction. Use ordinary vacuum/maintenance as with other current-state indexes; historical editorial rows cannot
become residual filters. A per-subject projection readiness row, keyed `(route, subject_id)`, records whether current
state is complete for its semantic revision; an incomplete projection is unavailable, never an authoritative absence.

Dependency ids are canonical structured keys, not a hash with unchecked collisions. The dependency home is the
referenced subject route for subject disclosure, and `tupleRoute(routeKey, source, external_id)` for imported fences,
with field group in the exact key. Candidate gates live in their source partition. Dependencies are registered before
contributions become visible and removal is generation checked. Registering against a pending gate retries. The drain
has a durable cursor and a bounded page size; it enumerates changed dependencies, never a whole source subject.

## Same-statement qualifier signatures

A signature is a canonical sorted set of `(qualifier property, item id)` atoms. The empty signature covers unqualified
membership. For each adopted eligible statement, materialize all distinct subsets of its item atoms of size at most
four. The statement validator admits at most 16 qualifiers and the shared filter limits permit four qualifier predicates
with at most 64 values each. Thus one changed statement produces at most
`F = sum(C(16,k), k=0..4) = 2517` signature contributions. Duplicate atoms collapse before subset enumeration.
There is no restriction to the relation's filter or slotKey qualifier: every admitted item qualifier participates.

For a probe, enumerate one atom from each qualifier predicate's `in` list, canonicalize each resulting set, deduplicate,
and point-read those signatures. Duplicate predicates on the same property still retain their AND meaning: each list
must have a value present on the witness statement; overlapping lists can choose the same atom. An empty `in` list
cannot match. The number of signature points is at most `A = 64^4` for permitted inputs, independent of degree.
Unqualified probes use one point. The port validates the same filter-input bounds; it must not silently narrow valid
queries to a single qualifier or value. The large worst-case constant is a storage/query tradeoff, not a claimed cheap
common-case query. Any future optimization must preserve the same proof and measurements.

A positive member exists only if a SINGLE candidate contributed that ENTIRE signature. In particular, counts for
`{left=L}` and `{right=R}` do not establish `{left=L,right=R}`. Joining separate inverted lists on subject/target would
be incorrect. Joining on candidate with an unbounded intersection would also violate the access bound.

## Snapshot algorithm

1. Validate partition and all source anchors before SQL. Point-read the subject, current release and projection
   readiness. Resolve the bounded declared facet list from the immutable release: at most 16 facets per type.
2. For each declared relation facet, seek the complete sample prefix and read at most 129 entries in stable
   `(slot_id,candidate_id)` order. Never enumerate inbound links, candidate history or all slots. The partial index
   contains current locally eligible Global selections, including compact state without a proposal row.
3. Batch point-read final statement/subject gates and referenced target and imported-source gates. At most 129 bounded
   payloads and their bounded dependencies are examined per property. Fence reads use full
   `(route,source,external_id,field_group)` keys in `content.source_fences`; hidden candidates use
   `(route,subject_id,candidate_id)`, subjects use `(route,subject_id)` and redirect uses its latest indexed sequence.
   Current entry/slot generations provide adoption/retraction evidence without folding the immutable fact log.
4. Return at most 128 disclosable sampled entries with their own qualifiers. A 129th eligible entry establishes
   overflow. If final checks remove entries, do not scan forward to refill. Conservatively mark that property overflow
   whenever the bounded read cannot prove completeness; never silently label a truncated prefix complete. An exhausted
   prefix of at most 128 entries with all gates completed and checked is complete. Sort overflow names for stability.

The relation part examines at most `129 * R` current entry rows plus bounded point evidence per payload, where R is
the declared relation facet count. Gate-generation validation can cause a retry, never an unbounded scan. With fixed R
and bounded payload/qualifier sizes, rows and SQL statements are constant in relation degree and history, while index
blocks grow logarithmically. This derivation concerns the added relation contribution; it does not grant permission to
expand existing descriptive reads or bypass their independent bounds.

## Point algorithm and final authoritativeness

Validate the whole call before acquiring a data connection: partition integer in `[0,4095]`, at most 256 probes,
every anchor a routable UUID in that partition, and bounded valid qualifier inputs. Main target and item qualifier ids
may route elsewhere; they are values, not source anchors. Preserve duplicates and original result positions. Empty
input returns `[]`. Missing, nonfacet, hidden or redirected source subjects cannot match; missing targets, absent
members, pending candidates, rejected candidates, unadopted acceptances and retracted selections cannot match.

For each `(subject,property,value)` read its current empty-signature membership point, then the bounded requested
signature points. Zero current counts are authoritative only with completed source readiness. A live witness carries
its candidate/slot generation and imported provenance. Validate that exact witness against current entry, hidden
candidate, source/target visibility, redirect and fence evidence using exact points. No slot enumeration is permitted.
A generation mismatch does not invite scanning the remaining witnesses. Retry the publication protocol or reject
unavailable. Once a gate update is completed, all affected aggregates have been repaired, so a live alternative witness
is already selectable and a removed last witness yields zero. This is why the barrier is necessary for exact negatives
and for qualified matches after individual witnesses disappear.

With P probes, each call examines at most `P * (1 + A)` aggregate rows and a bounded number B of payload/gate rows per
successful signature. Use the conservative budget B = 256 exact evidence-row lookups per witness: at most 17 item
targets (main plus 16 qualifiers), one imported proposing-source tuple, and source/candidate/slot/readiness gates with
before/after generation checks. Batch duplicates without increasing that budget. Thus the bound is
`O(P * (1 + A) * B)` rows/statements and that bound times index depth for blocks. For fixed
permitted filter inputs these are O(P) and O(P log N). Each individual SQL statement is anchored to one partition.
Batch signature reads and final evidence by partition; chunk source-fence tuples to their existing 100-tuple bound.
Neither matching nor final fence checking touches every same-target slot. P is at most 256; chunking belongs to Search.

## Write, replay, merge and moderation lifecycle

Compact creation installs selected entries and signatures in its source command. A proposal records provenance and
pending candidate state without a contribution. Acceptance alone does not contribute. Expansion copies the currently
selected compact entries into current slot state before the command commits. Adoption/replacement diffs only the old
and new bounded selection of the addressed slot. Global empty replacement suppresses that slot; community suppression
has no effect on Global membership. Rejection cannot target a currently selected candidate; suppress its adoption first. Rejected unselected candidates
never contribute. Retraction, candidate hide/takedown and restore update affected selected statements and their signature
deltas transactionally. No operation rediscovers current members by scanning a subject.

A declaration/release change has an explicit backfill/readiness transition; do not pretend a new facet has a complete
empty projection. Replay rebuilds entries, signatures, counts and dependencies from the authoritative semantic log in
bounded pages, then atomically publishes readiness for the replay revision. Partial replay cannot disclose or prove
absence. Repeated envelope delivery applies statement/generation deltas once. Sampling order does not depend on arrival
order, time or random selection. Semantic command maintenance, not a target search document, owns membership truth.

Merge redirects make the losing source unindexable immediately. Moving statements uses existing bounded member/link
pages, rewriting each changed statement's source route and dependency registration, then signature deltas. Target
merge/visibility changes drain only registered affected statements through their source partitions; this is dependency
maintenance, not rebuilding target documents. A source relation change schedules only its source search snapshot.
It never schedules the relation target's search snapshot. Subject-wide moderation may gate the whole source at once;
restoring its individual eligible memberships is paged under pending readiness before publication.

For C changed statements, current-state work is O(C * F) indexed deltas and O(C * F log N) index work, plus bounded
payload validation and dependency registration. A fence/target change costs the number of dependent changed statements;
it does not claim O(1) write work for an arbitrary fanout. Ordinary relation changes are independent of all other source
relations and editorial history. There is no whole-subject rebuild and no target reindex.

## Executable checks and current gap

`relation-facet-source.test.ts` specifies Book author, nonfacet and incoming exclusion, descriptive behavior, compact
expansion/adoption, cap boundaries, deterministic sampling, qualified slotKey witnesses, final target and imported-source
fences, and pre-SQL input validation. Missing fields/methods fail explicit assertions rather than imports or typechecks.
`growth-relation-facet-source.test.ts` uses the shared growth database, catalog/background classifiers and `checkGrowth`
at `[64,512,4096]`, one warmup and three samples per scale. Each snapshot/present/absent/qualified-match/qualified-miss
operation has its own report. Degree, same-target slot count and a retracted slot's history grow; probe count stays one.
Each anchor starts with 128 relations per facet before the first scale, keeping the sample saturated; the scales add
64, 512 and 4096 relations and history entries. A present probe is selected outside the actual sample at every scale. Derived runner work is attributed to
seeding when run there; work triggered by the measured operation remains in that operation's capture.

The current product is expected to fail the snapshot and cap assertions because relations are excluded, and the point,
input, final-disclosure and growth assertions because production has no `matchRelationFacets`. These tests do not
modify Search's shared interface or frozen outcomes. They do not relax qualifier semantics to make a bounded proof fit.
