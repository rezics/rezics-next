# Current multi-leaf final proof under the shared 256-key budget

Research evidence, 2026-10-28. This report proposes no runtime, storage, accounting, admission or cursor decision.

## Finding

**The inspected implementation does not establish an always-fitting current final-proof unit.** Search's Scope
execution and Semantic's leaf producer are unavailable stubs. The actual committed relation-facet repair is real,
but does not index material slots, interpret ranges or qualifiers, or establish every supported negative. Its
completion therefore cannot supply the missing general final-proof guarantee.

The proposed fresh selected-slot replay has a concrete admitted countercase: nine distinct material properties,
32 selected facts apiece, and the only matching fact last in each property's actual traversal. Its selected-fact
work alone costs 288 raw keys. Even granting an ideal retained locator for one matching fact costs at least
`8 × 32 + 1 = 257`, before candidate, alias, lookahead, basis reconstruction or additional final rereads.
The one pending record cannot carry the other eight locators or their truth.

This refutes the proposed replay bound and the claim that **existing** repair makes it universal. It is not an
impossibility theorem for every possible future access structure or traversal algorithm. Reading the last ordinal
first defeats this particular placement; it does not bound arbitrary independent placements. No implemented
deterministic matching-locator path with the required general guarantee was found.

The smallest honest immediate action is to keep the missing final-proof capability explicit and require a
source-owned access/proof proposal with an aggregate cost proof before adoption. That is a release gate, not a
liveness repair. A universally successful repair retaining all the stated restrictions is **not demonstrated** by
the current contracts or code. The alternatives below identify exactly which additional contracts would be needed.

## Inspection boundary and authority

The worktree base is `5e6e0bffd426031b5cf4346e5a3632d5fb3490e8`. The inspected current `dev` is
`071b17980a5e39e286c88ba430576ed72d069764`; its Search, Semantic, filter, definitions and relevant Zone/scope files
have no changes relative to this base. References below to worktree files refer to that pinned content.
Repository code is AGPL-3.0-only (`package.json`); repository contracts own the meaning of the findings.

Both integrated ordering reports were read: [current](zone-type-list-order-current.md) and
[independent](zone-type-list-order-independent.md). The first explicitly leaves general multi-leaf final replay
unproved. Their ordered-candidate recommendation is conditional on bounded current residual proofs; neither
proves this condition. Neither existing report answering the present multi-leaf question was read.

Committed owner work was inspected with `git show`, without checking out or executing it:

| Evidence                | Pin and status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope/current matching  | [Search README](../../services/kernel/src/search/README.md), [scope-source.ts](../../services/kernel/src/search/scope-source.ts), [scope-progress.ts](../../services/kernel/src/search/scope-progress.ts), [current-filter-plan.ts](../../services/kernel/src/search/current-filter-plan.ts), [current-leaf.ts](../../services/kernel/src/search/current-leaf.ts), [disclosure/check.ts](../../services/kernel/src/search/disclosure/check.ts). Pure matching/planning is implemented; bounded native Scope execution is not.                |
| Native leaf contract    | [Semantic README, current-leaf evidence and identity ports](../../services/kernel/src/semantic/README.md), [scope-leaf-evidence.ts](../../services/kernel/src/semantic/scope-leaf-evidence.ts). Types, reservation validation and a zero-usage `not_ready` producer exist. No current facts are produced. The README labels the signature an implementation proposal rather than an approved production ABI.                                                                                                                                 |
| Actual selection        | [slots.ts](../../services/kernel/src/semantic/slots.ts), `slots-read-operation.sql`, `slots-read-compact.sql`, `slots-read-adoption.sql`, `slots-read-selection.sql`, [candidates.ts](../../services/kernel/src/semantic/candidates.ts), [item.ts](../../services/kernel/src/semantic/item.ts), [search-source.ts](../../services/kernel/src/semantic/search-source.ts). These are real current write/selection/projection machinery. The full-subject projection is not a bounded leaf port.                                                |
| Actual coalesced repair | Semantic relation-facet owner's committed tip `db7cee84736de18473dab16369ff6f7528d3584e`: [relation-facet-witnesses.ts](https://github.com/rezics/rezics-next/blob/db7cee84736de18473dab16369ff6f7528d3584e/services/kernel/src/semantic/relation-facet-witnesses.ts), its `facet-witness-*.sql`, writer SQL and migrations. Implementation originated at `4fc44443992ddf2a9c94a0c32de328375558e810`. Absent on inspected dev. This owner tip has no `scope-leaf-evidence.ts`.                                                               |
| Structural identity     | Semantic identity owner's committed tip `42294d5d97015ecc5f7bc4ba2bccaf586168f930`; [identity-basis.ts at its relevant implementation commit](https://github.com/rezics/rezics-next/blob/11866761d31f6f98a2b43b3af8f416cbaba563a3/services/kernel/src/semantic/identity-basis.ts) is unchanged there. It reads two released home observations and checks pending structural work. It is not a global fact/foreign-authority snapshot. Terminal and alias-group functions remain contractual dependencies, not delivered current dev exports. |

The distinction matters: this report does not claim to have observed a running native evaluator spend key 257.
It verifies admission and actual data paths, then derives the lower bound on the proposed replay algorithm.
Existing red native fixtures are evidence of required behavior, not evidence that the stub implements it.

## Concrete admitted native state

Use a legal active Global definitions release, not a Context extension. Context term extensions are relation-only;
the normal Global release publication/bootstrap path is the relevant capability here. Start from the bundled
release, clear saved filters for the fixture, add prefix `ex = https://example.test/`, and add:

```ts
// Definition recipe; illustrative research data, not a new repository test.
const properties = Array.from({ length: 9 }, (_, i) => `ex:m${i + 1}`);
const materialProperty = (p: string) => ({
  iri: `https://example.test/${p.slice(3)}`,
  labels: { en: p },
  mappings: [],
  datatype: 'quantity',
  multivalued: true,
  units: ['1'],
  qualifiers: [],
  value: valueSchema('quantity', { units: ['1'] }),
});
const typeDefinition = {
  iri: 'https://example.test/MultiMaterial',
  labels: { en: 'Multi material' },
  mappings: [],
  bases: [],
  properties,
  facets: properties,
};
```

For one visible, unredirected, readable native subject of that type, create one English label and, for every
property, 32 normal public assertions in this order. Assertion `j` has native value
`{ type: 'value', content: { amount: '+' + j, unit: '1' } }`, empty qualifiers and references, for `j = 1..32`.
The external draft uses `{ property: { id: p }, value, rank: 'normal', qualifiers: [], references: [] }`.
No target, consent exception, missing fence or foreign source is needed for the basic cost failure.

Evaluate the positive filter:

```ts
const filter = {
  and: properties.map((property) => ({
    statement: { property, range: { gte: 32, lte: 32, unit: '1' } },
  })),
};
```

Admission is established by the real code, not an invented unconstrained schema:

- [Definitions](../../packages/definitions/src/index.ts) permits 16 facets and 64 properties per type; nine
  quantity facets are supported. `multivalued: true` is necessary. The generated quantity value schema and units
  satisfy `validateRelease`; a normal authorized published/activated Global release is supported by
  [definitions.ts](../../services/kernel/src/semantic/definitions.ts).
- [Subject validation](../../packages/definitions/src/validate.ts) permits 32 entries per material slot and
  checks their release meaning. The write uses `9 × 32 + 1 = 289` current facts, below the actual 512-fact ceiling
  in `write-facts.ts` and `change-current-facts.sql`. A hypothetical 32-properties-times-32-facts subject would
  violate current limits and is not used here.
- [Filter admission](../../packages/filter/src/filter.ts) permits 32 expanded leaves, depth four and 64 values
  per `in`. This filter has nine positive, distinct range leaves, no qualifiers and depth two. It needs no type
  clause to supply its positive anchor. The planner cannot deduplicate leaves naming different properties.
- A read-only inline invocation of the repository's actual `validateRelease`, `checkSubjectInput`,
  `parseFilter`/`admitFilter`, `positiveFilter`, `compileCurrentFilter` and `holdsCurrentStatements` returned
  `releaseViolations: []`, `subject.violations: []`, `targets: []`, `positive: true`, nine leaves and matching
  ordinal `[32]` for each leaf. It wrote no fixture or test and made no database command. This verifies admission
  and matching, not successful native producer execution.

The native write/selection shape is also real. `itemFacts` allocates statement slot sequences in draft order;
`slots-read-compact.sql` traverses ascending `log_seq`. These 32 initial assertions are below the compact
33-operation bound. To obtain an expanded version without changing the selected evidence, propose one additional
unselected candidate per property. `writeProposal` invokes `expandSlot`, which copies the existing compact
identities, accepts them in Global, materializes the same selection and writes the expand marker at sequence 33.
The expanded selection contains the original 32 candidates, in the original order. Explicit Global replace
adoption likewise accepts at most 32 accepted, nondeprecated candidates for a multivalued property.

`slots-read-selection.sql` expands that selection `WITH ORDINALITY`, point-reads each candidate and orders by
`selected.ordinal`. Thus the proposed selection-phase reader's native traversal encounters the only matching
fact at ordinal 32. This is not a relation slot-key fixture disguised as a material slot, and no ordering by
amount or native range predicate exists on this path. Candidate identities are the real deterministic IDs from
the writers, not client-invented witness receipts.

## Cost and final-request failure

Let `s_i` be distinct selected candidate/compact assertion keys consumed to rediscover a current matching fact
for leaf `i`; let `H` be every other raw-key debit in the final request. All native point/row/byte/empty-seek costs
remain separate. For this ascending selected-slot replay, `s_i = 32` for all nine properties.

| Final-request method                                                           | Selected-evidence raw-key lower bound |
| ------------------------------------------------------------------------------ | ------------------------------------: |
| Fresh replay of all nine properties                                            |                         `Σ s_i = 288` |
| Ideal one-fact locator retained for any one property; fresh replay of the rest |              `1 + Σ(other s_i) = 257` |
| Above plus composition and any additional final reread                         |      at least `257 + H`, with `H ≥ 0` |

These are deliberately favorable **lower bounds**, not invented exact SQL-operation totals. Each distinct
candidate/assertion consumed is a charged raw key; internal drivers, discarded candidates, rereads and reserved
lookahead add charges. The native fixture's `accounted` helper also requires `keys ≥ witnesses ≥ facts.length`.
Returning 32 selected facts in one SQL statement or one JSON result does not turn them into one raw key.
The selection cap 32 and compact cap 33 bound shape; neither discounts reads.

The hypothetical one-fact locator is more generous than the actual selection continuation: `after` is an
exclusive consumed position, not permission to reuse that position's truth. Exact `revalidate` additionally
requires an opaque identity previously returned by the producer. Giving it a cost of just one key already fails
the bound. If fresh acquisition itself supplies the required final current observation, it need not be counted
twice; the failure still holds. If the composition requires another later witness read, that increases `H`.

Every call gets at most 101 keys and 100 witnesses, with actual usage subtracted from the **same** caller
reservation. Splitting 288 into calls of 96, 96 and 96 cannot fit a request with 256 remaining. Larger witness,
point, row or byte reservations do not enlarge the raw ledger. Empty probes spend their appropriate native axes;
this argument does not incorrectly count every empty seek as a returned raw key. Two 4096-home identity sweeps
cost at least 8192 metadata rows plus core observations per owner phase, separately from raw keys.

Request-local reuse is legitimate: selected evidence for one property can be read once, normalized once and
passed through the same Search matcher for several clauses, provided its authority observations are current and
actual acquisition/revalidation work is charged. Identical leaves are already deduplicated by the planner. Here
the nine slots and their facts are disjoint, so there is no shared selected-data acquisition to amortize.
Batching their SQL calls cannot remove their 288 raw candidate keys.

All nine leaves are true. Sound AND evaluation must establish all of them; OR short-circuiting and a definitive
false AND child do not help. A nonmatching partial window supplies `not_proven`, including under NOT. A predicate
can succeed on one selected fact, but the producer cannot select that fact by interpreting the range for Search.
`SubjectSource.read` loading the whole subject is neither a free point lookup nor the admitted bounded port.

This placement specifically defeats replay in the actual ascending selection traversal. It does not defeat an
algorithm that happens to try ordinal 32 first. More generally, the current material path has no query-dependent
value locator: values can be independently assigned to selected identities, so a fixed traversal may encounter
the only match last. Trying reverse order merely changes that assignment. A claim about every conceivable
algorithm, compressed data structure or permitted future index would need a separate proof; none is asserted.

## Why pending progress and foreign bases do not complete the proof

The eight Zone fields and the one 18-byte Search record carry structural/query bases, the actual pending original,
one leaf ordinal, phase, value ordinal and consumed raw position. `scope-progress.ts` allocates all 16 payload
bytes to that one sequence/UUID. They carry no earlier-leaf truths or witness list. A digest cannot be decoded
into the eight forgotten identities. A server map keyed by that digest would be the excluded cross-request proof
cache, even if called an owner record or maintenance result.

In a fixed, finite, fully repaired ready state, an individual leaf can make finite progress to ordinal 32. If a
later request must then restart all earlier positives, the successful terminal unit still exceeds the budget.
Rotating the pending leaf or repeatedly starting fresh can postpone the same failure forever. Requesting another
completed relation repair does not change these material slots. That is a liveness gap in replay, not a missing
continuation bit or an acceptable forever-readiness result.

Foreign changes independently rule out treating a source-local selection version as current truth. A legal
variant proposes selected facts through the existing sourced bulk path, accepts them and adopts them in Global.
Their `Source` is recovered from the exact proposing/recording revision by `candidateSources`; `fencedIds` routes
to Content's tuple home and reads current `readFences`. After an earlier positive, take down its foreign tuple
without changing the source's adoption. The old positive is invalid even though its local selection is unchanged.
The existing leaf fixture exercises this with imported `schema:inLanguage = 'en'`; it also exercises referenced
target hide/restore and public `sourceOrConsent` revocation. Material quantity facts can likewise have imported
provenance; no item target is needed for their foreign-fence dependency.

Concretely, replace each property's ordinal-32 selection entry with an accepted bulk-proposed `+32` candidate
whose source is `{ source: 'openlibrary', external_id: 'multileaf-m' + i, field_group: 'facts',
record_revision: 'unversioned', digest: 'e'.repeat(64), converter_revision: 'openlibrary@1' }`, with a public
`schema:url` reference as required by the batch schema. Keep the other 31 candidates and put this candidate last
in Global replace adoption. With all nine tuple fences up, final evaluation is true. Taking down only the tuple
for `multileaf-m1` makes the old matching fact unusable without changing that adoption. Restoring it can change
the outcome again. Tuple routes are computed by the existing `tupleRoute`/`sourceTuple`; select an external ID
at another home when testing the foreign-only case. These are source observations to recheck, not fields carried
in `SelectedLeafFact` or a new authority digest.

The source/property progress basis intentionally does not certify all previously rejected foreign witnesses.
Complete selection coverage must include relevant current foreign observations. The structural identity-home
digest does not include every fence, consent or target observation. Final original, terminal, source and fact
authority checks remain necessary. Keeping a per-request RR client for one anchor is not a snapshot across
released transactions or other homes, and no browser/PIT/persistent snapshot is proposed.

The countercase already works with one canonical original. Adding 257 or 4096 aliases is an independent bound:
earlier windows may consume rejected originals over multiple calls; the pending original must remain in
`aliasAfter` and be resumed before seeking beyond it. The final request need not rediscover every alias, but it
must prove the retained original and terminal current. That mechanism stores no extra leaf facts. UUID Scope/Zone
union can be forced to rely on this sole positive Scope; an alternative true union source is not guaranteed.
An ordered TypeList can place this subject at its next indispensable candidate. It cannot preserve semantics by
skipping unknown membership, and fitting a long name tuple would not reduce any of these evidence reads.

## What completed coalesced repair actually gives

The committed implementation is specifically **relation pair** witness maintenance:

1. `relationFacetProperties` filters the release's facets by `property.relation`. The possible-identity table's
   key is `(route, subject, property, value UUID, statement UUID)`. Migration
   `20261027061803_relation_facet_witnesses.sql`, `insert-facts.sql`, `candidates-insert-candidate.sql` and
   `slots-insert-candidate.sql` populate it for routed-UUID relation values. Material quantities, times, codes and
   nonrelation item slots do not enter it.
2. `requestFacetRebuild` coalesces source-home requests with durable requested/active/published generations.
   `relationFacetRebuilds` pages actual possible identities, remembers `(property, value, statement)` frontier,
   checks current visible selected witnesses and stages a useful witness per pair. Publication switches one
   generation only after its finite scan ends; a request arriving during a build schedules subsequent work.
   The page size is bounded, so fair successful maintenance over a finite quiescent input can complete.
3. `facet-witness-stage.sql` stores one witness per `(subject, generation, property, value UUID)`; the hint lookup
   uses that exact pair and published generation. `visibleWitnesses` rechecks compact/expanded selection,
   moderation/retraction, provenance fences and target visibility. Its current normalization hardcodes normal
   rank; the leaf contract explicitly requires extracting/extending it and `indexedStatement`, rather than
   treating the old helper as a completed general native leaf implementation.
4. The old `matchFacetProbes` tries the recorded witness and at most 32 alternatives. A miss is `not_proven`
   and may request repair, never definitive false. Its maximum input count 256 is not the Scope aggregate ledger;
   it has no caller `LeafWork` accounting/continuation. The snapshot's first 128 relation values are not coverage.

Finite repair can therefore make a surviving relation pair's positive hint useful, including a witness beyond a
previous 32-sample. It does not make that hint current without a charged recheck. It supplies **no hint at all**
for the nine material slots above. The owner's descriptive-fact and witness-identity indexes are access paths,
not indexes answering arbitrary material predicates.

This is a committed runnable factory, not proof of deployed default composition: that owner's `src/worker.ts`
starts `effectsRelay` and `linkProjection`, without `relationFacetRebuilds`. The finite-maintenance argument here
grants an explicitly scheduled, fairly run factory and completed repair, as the question requests. Missing worker
wiring is another delivery dependency, not the reason the material countercase fails.

Nor does completed repair establish every negative. The leaf contract allows `selection` only after the entire
bounded selected slot and its foreign observations are current; `empty_pair` requires an exactly empty, complete
possible-identity prefix for every requested pair. A historical nonempty pair whose current visible hint has
disappeared cannot use `empty_pair`, even after repair. End of such a stream can legitimately remain unknown.
Thus universal definitive-negative liveness would itself require an owning contract change; it cannot be inferred
from a published repair generation. No explicit worst-case final debit `≤ 256` follows from this implementation.

## Remedies, dependencies and recommendation

| Remedy                                                                           | What it honestly repairs                                                                                | Required owner work and remaining limit                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request-local selected-data reuse, witness-first ordering, sound Boolean pruning | Avoids duplicate reads and improves common cases without transporting truth.                            | Search `current-filter-plan.ts`, `scope-source.ts`, `disclosure/check.ts`; Semantic shared selection extraction. No universal bound for independent material properties. Not sufficient adoption evidence.                                                                                                                                                                                                                   |
| Extend query-independent useful hints to material equality                       | Could make a known item/code equality witness cheap to rediscover.                                      | Semantic `relation-facet-witnesses.ts`, writer/expansion SQL, migrations, bootstrap, worker composition and `search-source.ts` normalization; revise Semantic README and relation-facet design. Must keep selected/runtime authority checks. Equality indexing alone does not cover arbitrary inclusive ranges, same-statement qualifier conjunctions or definitive negatives. No whole-filter truth should enter this port. |
| Source-owned additive locator/access seam covering all admitted material shapes  | Potential real repair while retaining Search as sole matcher and the same selection/provenance runtime. | Semantic must first specify query-independent data/index coverage, bounded locator acquisition, fresh selected-fact retrieval, negative coverage and repair convergence for code/item/range/qualifier leaves. Search README/`scope-source.ts` must reserve final work using its actual charge table. This is a proposal obligation, not an existing implementation or proven universally feasible design.                    |
| Transport a bounded witness vector                                               | Avoids rediscovering eight earlier positives; still requires current revalidation.                      | Changes Search/Semantic progress and `docs/zone-membership.md` plus token/cursor contracts. Conflicts with the present one-record/no-vector instruction. Cannot hide it in owner records, eight keys or server state. Requires an explicit supermanager decision.                                                                                                                                                            |
| Enlarge ledger or reduce admitted worst-case work                                | Can address the replay arithmetic if sized from a complete legal worst case.                            | Changes shared Zone/Search/Semantic reservation or filter/release contracts and independent acceptance. `288` is only this fixture's discovery cost, not a sufficient new universal ceiling. Reducing leaves, selection size or supported predicates also changes admission. Requires an explicit supermanager decision; not recommended silently.                                                                           |

A useful numeric target for the proposed access seam is explicit rather than “bounded”: with `L ≤ 32`, prove
`H + Σ(discover_i + acquire_i + final_i) ≤ 256`, charging every internal candidate/driver and reread. For example,
an _actually proved_ one-key locator, one-key acquisition and one-key final reread per leaf would cost at most
`96 + H`, leaving 160 raw keys for composition. This is a conditional budget target, **not** the existing port's
cost: an opaque identity lookup may need more than one raw driver, 64 alternatives may need more than one lookup,
and qualifiers/negative proofs may need many facts. A four-key-per-leaf final path would leave only 128 for `H`.
All five native axes need independent inequalities as well. Alias/candidate lookahead and final identity phases
must be assigned explicit reservations, not assumed to fit the remainder.

The smallest storage-oriented extension worth designing is source-owned, query-independent selected-evidence
access shared with the real slot/witness resolver. An implementation proposal must explain how it supplies useful
locators for **every** admitted range/qualifier shape without a private query interpreter, native SQL predicate
evaluation, hidden witness cache, or scanning all history outside the ledger. Merely renaming matching hints as
“data” does not discharge that obligation. Packing 32 facts into an owner row and charging one key changes the
accounting unit; allowing range/qualifier SQL pushdown changes the interpreter boundary. Neither is an additive
repair under the present contract.

The precise source handoff is `services/kernel/src/semantic/README.md`'s current-leaf/coverage contract and
`scope-leaf-evidence.ts`, with shared extraction from `slots.ts`, `search-source.ts`, `relation-facet-witnesses.ts`,
`fences.ts` and `statement-disclosure.ts`. Any new data access path needs its own typed SQL, semantic migration,
writer/expansion/bootstrap completeness and bounded worker scheduling in `services/kernel/src/worker.ts`.
Foreign dependency fanout remains the separate `relation-facet-rebuilds-design.md` handoff; it is not material
locator storage. Search owns `services/kernel/src/search/README.md`, `scope-source.ts` and `service-scope.ts`
reservation/composition changes, retaining `current-leaf.ts` and `current-filter-plan.ts` as shared truth logic.
Actual identity, canonical-index coverage and owner residual ports are prerequisites. Content's existing fence
authority is reused; no independent holder/permission engine or new core authority follows from this proposal.

Recommend adopting the negative finding and this proof obligation now, then assigning the access-seam design to
Semantic with Search's cost/composition review. Preserve 256, current admission and no cross-request proof cache.
If that owner cannot prove the inequality for all admitted leaves, escalate the precise conflicting restriction
to the supermanager instead of claiming existing repair has solved it. Permanent readiness in the fixed ready
fixture is a failed liveness acceptance, not the proposed solution. No native/core port, key unit, storage format
or policy is chosen by this report.

## Independent native acceptance required before adoption

Keep existing acceptance frozen. Add independently owned native outcomes, using real commands, releases, Access,
selection, pools and engine drivers, after the missing producers are delivered:

- The legal nine-property fixture above, compact and expanded, then independently placed matching ordinals per
  property. Complete maintenance first and hold a fixed fully ready state. Traverse to a positive final result in
  finitely many calls without a growing token, truth/witness cache, repeated unchanged readiness or overspend.
  Include the worst **legal** 32-leaf/64-value shapes and native 512-current-fact/16-facet-per-type limits; permit
  correct request-local reuse while measuring all actual keys. Do not fabricate a 1024-current-fact source.
- Combine that final-proof test with real 257- and 4096-original alias groups, only the last readable/eligible.
  Pause on a later material leaf, retain that original in the actual eight-field encrypted handoff, resume it
  first, and prove both the Scope/Zone UUID union and ordered TypeList residual outcomes. Include 257/4096
  same-pair witness histories with only the last currently readable witness. Single-leaf reachability alone fails
  to establish the combined result.
- Capture multiple leaf calls, multiple Scope sources and alias/candidate windows under one shared 256 ledger.
  Assert each raw driver, duplicate, discarded key, lookahead, resume-basis probe and final reread before the next
  dispatch; no per-call or per-source reset. Capture points, witnesses, rows, bytes and empty seeks separately,
  including released fixed-home preparation/continuation/final phases. Exercise a pool of size one.
- Revoke original/terminal/source Access, current selection, moderation, public consent, referenced targets and
  imported fences between discovery and final use. Include foreign-only changes with unchanged local selection,
  and restore a rejected witness behind the keyset. Fresh final evidence must suppress stale positives or restart
  safely, without converting unknown to false or resurrecting an earlier allow claim.
- For each proposed hint family, cover equality/code, time/quantity bounds and units, 64-value leaves, all supported
  same-statement qualifiers, and every claimed definitive-negative certificate. Include nonempty historical pairs
  with no visible witness; preserve current unknown semantics unless the owning contract explicitly changes.
  Verify coalesced restart/crash recovery and completed repair before asserting final bounded liveness.
- Use the actual shared `holdsCurrentType`/`holdsCurrentStatements` and `compileCurrentFilter`; no fake hit or test
  interpreter. OR may settle on an independently current true child and AND on a definitive false child, but the
  all-true AND must really establish every leaf. An essential unknown ordered candidate blocks later disclosure.

Extend the real `test/semantic/scope-leaf-evidence.test.ts`, `scope-leaf-identity-composition.test.ts`,
`growth-scope-leaf-evidence.test.ts` and `test/search/scope-evaluate.test.ts` through separately named suites;
retain `scope-prefix.test.ts` aggregate accounting. Existing tests exercise real selected facts, small Boolean
plans, scarce-budget unknowns and individual last-survivor progress. They do not currently assert successful
worst-case multi-leaf final completion. This research task adds no test or implementation.

## Primary implementation references and shared patterns

PostgreSQL's executor separates access from qualification: pinned `ExecScanExtended` repeatedly obtains tuples
and applies its qualifier until a tuple passes. `BitmapHeapNext` rechecks the original condition for tuples from
lossy bitmap pages. These are mature examples of candidate acceleration plus authoritative residual evaluation,
not guarantees that a result limit bounds examined candidates. Sources: [execScan.h](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/executor/execScan.h)
and [nodeBitmapHeapscan.c](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeBitmapHeapscan.c).

PostgreSQL documents that bitmap combinations visit actual table rows and lose the original indexes' order.
An index matching `ORDER BY` can avoid scanning the remainder for a simple ordered limit, but that fact supplies
no bound on a separate REZICS current-authority residual. See [Combining Multiple Indexes](https://www.postgresql.org/docs/18/indexes-bitmap-scans.html)
and [Indexes and ORDER BY](https://www.postgresql.org/docs/18/indexes-ordering.html). Its transaction documentation
also distinguishes per-command Read Committed observations from the stable snapshot of one Repeatable Read
transaction; neither creates a common snapshot across independently released REZICS home reads. See
[Transaction Isolation](https://www.postgresql.org/docs/18/transaction-iso.html). The last application to this
repository is an inference from its own read/identity contracts, not a PostgreSQL feature claim.

The shared pattern is to make acceleration coverage and residual verification explicit, account actual input
work, and distinguish transaction/cursor scope from authority. This supports a source-owned data access proposal;
it does not authorize copying PostgreSQL's predicate engine or retaining its bitmap between browser requests.
The reused reference clone is
`/home/edge/projects/rezics/rezics-next/.reference/library-shelf-maintenance/postgres`, commit
`700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, URL `https://github.com/postgres/postgres.git`, PostgreSQL License
(`COPYRIGHT`), inspected 2026-10-28. Source objects were read with `git show`; nothing from the clone was installed,
built or run. The reuse/pin/licence/date entry is recorded in `.reference/INDEX.md`.

Interpretive decisions: “current evaluator” means the promised admitted native composition, with stubs explicitly
distinguished; the lower bound counts actual distinct selected keys rather than result cardinality; the custom
Global release is legal admission rather than a Context-extension escape; one retained locator is an optimistic
lower-bound allowance rather than an approved wire field; within-request evidence reuse is allowed but cannot
carry prior truth; final rereads are not double-counted when an observation already meets the final contract;
current historical-pair unknown semantics remain intact. Ordering/cursor-size work and any shipping contract
changes remain with their owners.
