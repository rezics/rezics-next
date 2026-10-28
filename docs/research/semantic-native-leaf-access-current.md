# Native Semantic leaf access: a complete-selection restriction conflict

Research date: 2026-10-28. This is evidence for an owner decision, not an adopted
design, production ABI, permission change, or implementation plan.

## Finding

The universal final-proof requirement conflicts with the **existing complete-selection
coverage operation**, independently of the previously demonstrated positive-witness
replay problem. A legal, fully readable subject with sixteen quantity facets and
31 selected statements per facet requires at least **496 distinct current raw fact
keys** for one final positive evaluation of an admitted filter. The filter uses a
positive type anchor and `NOT` of a false sixteen-way `OR`. Its negative leaves
require current complete selection coverage. The aggregate allowance is 256.

This is a mandatory-access lower bound under the explicit evidence/coverage rules.
It is not a claim that every conceivable access structure needs 496 reads to answer
the mathematical query. A query-independent maximum-value index could distinguish
this particular dataset cheaply. It cannot issue either of the two existing
coverage certificates without satisfying their existing definitions. Calling that
index observation a complete selection read would change a restriction.

The smallest restriction needing Root's decision is therefore whether to retain
the requirement that a non-item negative leaf's certificate reads the **entire
current selected slot in the final observation**, or authorize a different native
data-coverage certificate with a separately proved Search interpretation. Allowing
a new range seek alone does not remove this certificate obligation. Source cannot
adopt either exception, grant Access changes, or silently narrow admitted `NOT`
semantics. No exception is selected here.

## Evidence pins and independence

All unqualified repository paths below are relative to this repository. Source
citations use immutable commits; the working tree inspected was
`1f836e3f9c656acb9472b324b52a5766ddb13e34`, also the inspected `dev` tip. Native
selection and Search evidence contracts, rather than reference-project behavior,
define the operation model used in the proof.

| Material inspected                                                 | Exact revision and status                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integrated code, schemas, typed SQL, limits and contracts          | [`1f836e3f9c656acb9472b324b52a5766ddb13e34`](https://github.com/rezics/rezics-next/tree/1f836e3f9c656acb9472b324b52a5766ddb13e34)                                                                                                                                                          |
| Required pinned prior report, read in full from its owning history | [`d3a7577474`, `docs/research/search-multileaf-final-proof-pinned-sol.md`](https://github.com/rezics/rezics-next/blob/d3a7577474/docs/research/search-multileaf-final-proof-pinned-sol.md)                                                                                                 |
| Required independent prior report, read in full                    | [`1af969e4e2ffbb845a214ec0dbbbbeb1beda7971`, `docs/research/search-multileaf-final-proof-independent.md`](https://github.com/rezics/rezics-next/blob/1af969e4e2ffbb845a214ec0dbbbbeb1beda7971/docs/research/search-multileaf-final-proof-independent.md), integrated in the inspected tree |
| Current-leaf contract history                                      | `2c521ddb67`, integrated as `6e50e11583`; also inspected the owner's `3844fee1f6dc805521a78ab162c2d7ae026c2c16` contract tip                                                                                                                                                               |
| Delivered independent evidence export                              | [`5f75fe673d11058be9d7c1fef7b3daa556eedaa0`](https://github.com/rezics/rezics-next/blob/5f75fe673d11058be9d7c1fef7b3daa556eedaa0/services/kernel/src/semantic/scope-leaf-evidence.ts), integrated: real types and input validation, **zero-work `not_ready` stub**                         |
| Relation witness producer and typed SQL                            | [`db7cee84736de18473dab16369ff6f7528d3584e`](https://github.com/rezics/rezics-next/tree/db7cee84736de18473dab16369ff6f7528d3584e/services/kernel/src/semantic), inspected owner tip; repair originated at `4fc44443992ddf2a9c94a0c32de328375558e810`; not integrated in the inspected base |
| Native identity basis implementation                               | [`42294d5d97015ecc5f7bc4ba2bccaf586168f930`](https://github.com/rezics/rezics-next/blob/42294d5d97015ecc5f7bc4ba2bccaf586168f930/services/kernel/src/semantic/identity-basis.ts), owning history; integrated base does not expose the complete identity ports                              |

The two required reports establish path-specific 288/257 failures, including real
shared-matcher admission checks; neither proves impossibility for every index.
This report instead proves an unavoidable complete-selection certificate cost on
a false `OR` beneath `NOT`. It does not depend on choosing a bad matching ordinal,
replaying nine positives, or refusing a useful hint. The other new Source-access
report and the manager's conclusion on it were not consulted.

The inspected earlier pair-absence owner history at
`d068e26cad21a2bb838762f8ed8821a53414b10c` still contains the older
`semantic/relation-facets-design.md` specification, rather than the integrated
closed current-leaf export. The exact complete-pair rule used here is the quoted
`empty_pair` rule in the integrated Semantic README and its native acceptance
fixture. That rule is not inferred from the older sampled snapshot's broader
negative-convergence wording. Likewise, the delivered leaf-export pin above is
the actual pending producer state, not evidence that a complete native reader ran.

Repository licensing is [`AGPL-3.0-only`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/package.json),
with the definitions and filter packages declaring their own Apache-2.0 licences.
These are source citations and design analysis; no implementation was copied.

## Exact admitted operations and authority

The controlling clauses are in
[`services/kernel/src/semantic/README.md`, “Current leaf evidence”](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/README.md).
In particular:

> Statement constraints may select a proven complete possible-witness pair range
> for item values; otherwise read the property's bounded selected slot.
> Range/qualifier predicates are not SQL filters.

> `selection` means the ENTIRE bounded current native selected slot has been read
> in this observation, including all relevant current target/fence checks.

> `empty_pair` means an exact EMPTY full `(route, subject_id, property, value)`
> prefix of the synchronously maintained possible-witness superset, with
> native/compact writes, expansion, proposal and old-data bootstrap coverage
> proved complete, for EVERY requested pair in the leaf.

The following sentence expressly excludes nonempty historical pairs, even after
their visible hints disappear. A hint miss, generation, exhausted rejected stream,
unknown target, sampled values, or recorded-plus-32 misses is not coverage. Without
coverage, nonmatching evidence is unknown, including under `NOT`. Conversely, a
matching current witness can establish a positive with null coverage.

The closed native ABI in `scope-leaf-evidence.ts` has these meanings:

| Input/output                                                 | Meaning and authority                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `subject: string`                                            | Already-known native source anchor; does not resolve or authorize an unprovided original                                       |
| `leaf: FactClause`                                           | One already admitted type or statement leaf, not an arbitrary Boolean AST or executable predicate                              |
| `after: {basis, phase, valueOrdinal, after} \| null`         | Raw compact sequence, selected ordinal, or witness UUID progress; no prior truth                                               |
| `revalidate: string \| null`                                 | One previously returned opaque identity, at most 128 ASCII bytes, exclusive with `after`; no supplied body or allow receipt    |
| `budget: {keys, points, witnesses, rows, bytes, emptySeeks}` | Independent reservations, all positive safe integers for a nonempty read                                                       |
| `facts[]`                                                    | `{witness, statement: IndexedStatement, release, revision, rank: 'normal' \| 'preferred'}`; current public normalized evidence |
| `coverage`                                                   | Only `{kind: 'selection' \| 'empty_pair', basis}` or null                                                                      |
| `state` and `usage`                                          | `current`, `basis_changed`, or `not_ready`, with actual work, never the reservation as consumption                             |

Type evidence is the actual current `subject.type`, with current coverage and no
statement facts. Nonvisible/redirected/unready anchors do not become false leaves.
Search alone applies type membership, material item/code membership, time/quantity
ranges, units, same-statement qualifiers, and AND/OR/NOT. The actual implementation
is [`search/current-leaf.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/search/current-leaf.ts)
and [`search/current-filter-plan.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/search/current-filter-plan.ts),
also used by `search/disclosure/check.ts`. The planner deduplicates normalized
leaves and propagates `not_proven` through the same Boolean interpreter.

The existing independent native fixture's bridge maps a matching current fact to
true; otherwise only same-basis nonnull coverage maps to false. Everything else is
`not_proven`. See
[`test/semantic/scope-leaf-evidence-fixture.ts`, `currentEvaluator`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/test/semantic/scope-leaf-evidence-fixture.ts).
This is evidence of the intended certificate algebra, not a second matcher.

## A real admitted counterexample to the universal bound

Construct a valid extension of the bundled release with sixteen **material**
quantity properties `ex:p00` through `ex:p15`, not relation properties. Each is
multivalued, has unit `1`, no qualifiers, and a value schema from
`valueSchema('quantity', {units: ['1']})`. Add type `ex:Selected` with exactly those
sixteen properties and sixteen facets. There is no property minimum or maximum
that would imply the query result independently of the subject.

The subject has one English label and, for each property, 31 different normal
statements with amounts `+1` through `+31`, unit `1`, and no item targets. All are
current, publicly readable, unhidden, unretracted and unfenced. The subject has
no redirect; its only original and terminal can be itself. All homes and required
maintenance are ready and cease changing before evaluation.

The filter, using the actual wire grammar, is:

```ts
{
  and: [
    { type: { in: ['ex:Selected'] } },
    {
      not: {
        or: properties.map((property) => ({
          statement: { property, range: { gte: 100, lte: 200, unit: '1' } },
        })),
      },
    },
  ],
}
```

Here `properties` is the sorted sixteen-property list above. This is a concrete
finite family, not a proposal to admit `map` or code in a filter.

The actual pure admission checks were executed in the assigned worktree with Bun:
`validateRelease`, `checkSubjectInput`, `itemFacts`, `parseFilter`, `admitFilter`,
`positiveFilter`, `compileCurrentFilter`, `holdsCurrentType` and
`holdsCurrentStatements`. Quantity normalization for this pure calculation used
the existing `Number(content.amount)` and unit fields from the private
`search-source.ts:indexedStatement`; it did not run a native evidence producer or
claim native usage. Results:

```json
{
  "releaseViolations": [],
  "subject": { "violations": [], "targets": [] },
  "positive": true,
  "leaves": 17,
  "facts": 497,
  "materialFacts": 496,
  "leafResults": [
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false
  ],
  "final": true,
  "partial": "not_proven"
}
```

The source ID used by `itemFacts` was the canonical routed ID
`00000000-0000-8000-8000-740000000001`. Subject inputs used the existing statement
envelope `{property: {id}, value: {type: 'value', content: {amount, unit}},
qualifiers: []}`. No hand-written expanded `FactClause` bypassed admission.
The actual Search engine compiler `compileFilter` also compiled this filter with
`{prefix: 'f', relationOverflow: true}` and returned 17 leaf queries. Engine
candidate narrowing therefore does not exclude this admitted shape; it still
cannot replace current native final evidence.

The relevant real bounds are:

| Bound                            | This fixture       | Current limit/source                                       |
| -------------------------------- | ------------------ | ---------------------------------------------------------- |
| Material selected facts per slot | 31                 | 32, Semantic selection and subject validation              |
| Current facts including label    | 497                | 512, `change-current-facts.sql` and definitions validation |
| Properties / facets on type      | 16 / 16            | 64 / 16, `RELEASE_LIMITS`                                  |
| Expanded filter leaves           | 17                 | 32, `FILTER_LIMITS`                                        |
| `OR` children                    | 16                 | 16                                                         |
| Depth                            | 3 edges below root | 4                                                          |
| Positive filter anchor           | True type leaf     | `positiveFilter` returns true                              |

Sources: [`packages/filter/src/filter.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/packages/filter/src/filter.ts),
[`packages/definitions/src/index.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/packages/definitions/src/index.ts),
[`packages/definitions/src/validate.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/packages/definitions/src/validate.ts),
[`semantic/item.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/item.ts)
and `semantic/change-current-facts.sql` at the same pin.

Compact writes create 31 operations per property, below the expansion threshold.
For an expanded variant, propose an additional unselected candidate, expand with
the existing writer, and retain the same 31 candidates in Global replacement
selection. That retains the same current material count. Neither variant needs
1024 current facts, 32 distinct facets, qualified relations, or a new datatype.

## Mandatory-access proof

Let `L_i` be the quantity leaf for property `i`, and `S_i` its 31 current selected
facts. These sixteen sets are disjoint native fact identities. Let `H = K_outer`
include all charged outer raw keys: discovery of this candidate, identities and
aliases where charged as raw keys, source checks, other sources, and lookahead.
All such consumption is nonnegative.

1. The shared matcher returns false for every `L_i`; the type leaf is true.
2. In the shared planner, a false `OR` requires **every** child false. A single
   `not_proven` child with no true child makes the `OR`, its `NOT`, and this final
   conjunction `not_proven`. Short-circuit ordering cannot remove a required child.
3. No returned current fact matches any `L_i`. The bridge therefore requires a
   current coverage certificate for each `L_i` before it can establish false.
4. `empty_pair` is a complete possible-**item**-witness prefix proof, not a quantity
   range certificate. It is unavailable here. Thus each certificate is `selection`.
5. By the explicit definition of `selection`, every fact of `S_i` must be read in
   **this** observation. Reading an ordinal, identity, or body through a new native
   index still consumes its actual raw fact/driver key. Packing the selected list
   into one charged owner row is expressly excluded. An extrema row does not read
   all 31 identities or observe their relevant current eligibility.
6. Sharing actual reads within the request is permitted. It saves no duplicate
   here: the sixteen slots are disjoint, and the bound charges each required fact
   exactly once. In particular, it does **not** charge discovery and a fused fresh
   final observation twice.

Consequently, even granting free discovery and every optional optimization:

```text
K_outer + sum_i(K_discovery,i + K_acquire,i + K_final,i)
  >= H + |union_i S_i|
   = H + 16 * 31
  >= 496
   > 256.
```

The partition of a shared actual read among discovery/acquisition/final terms is
immaterial; it appears once in their union. The label, type, slot-head, adoption,
candidate metadata, Access, and coverage bracket work have all been generously
omitted from the lower bound. Realistic outer headroom can only strengthen it.
The necessary fact-only feasibility condition is `sum_i |S_i| <= 256 - H`.

For example, the real Scope prefix ABI reserves quota plus one lookahead: a cold
quota-one prefix that actually reads its candidate and a nonempty lookahead has
already consumed two raw keys, leaving at most 254 before aliases, source evidence
and final work. Other candidates and sources consume further shared headroom.
This is a conditional actual-read count, not a claim that every composition has
the same outer cost. The contradiction above deliberately grants the stronger
allowance of all 256 keys to this one candidate's facts.

This is an **access lower bound imposed by a required certificate**, not an
information lower bound against arbitrary indexes. Under only ordinary
ordinal/point access, an unread statement could instead have amount `+150` and
change the final answer, illustrating why partial facts cannot establish false.
A stored numeric maximum can distinguish those worlds; the proof does not deny
that. It says exactly why distinguishing them through that new observation is
insufficient to label the observation with the frozen `selection` certificate.
There is no reliance on digest collisions or on hiding an index mutation.

### Shrinking ledger and convergence

An optimistic call table, ignoring every control read and granting no lookahead
cost, makes the obstruction explicit. Each call is below both 100-key and
100-witness limits, even before considering the native 101-key ceiling.

| Call                     | Newly read selected keys |   Aggregate keys |          Complete slots | Raw allowance left |
| ------------------------ | -----------------------: | ---------------: | ----------------------: | -----------------: |
| 1                        |                       93 |               93 |                       3 |                163 |
| 2                        |                       93 |              186 |                       6 |                 70 |
| 3                        |                       62 |              248 |                       8 |                  8 |
| 4                        |                        8 |              256 | 8, plus a partial ninth |                  0 |
| Remaining mandatory work |                      240 | 496 if completed |                      16 |         Infeasible |

This is a lower-bound illustration, not a proposed dispatch schedule: actual
per-call controls would require smaller windows. Completing the ninth slot alone
would require 279 fact keys. No choice of traversal order improves the union size.

On fixed finite fully ready input, let `M` be the number of required selected facts
not yet observed **in the current request**. A progressing scan reduces `M` from
496, but the budget is exhausted while `M >= 240`. Across requests the allowed
18-byte progress record can advance a raw ordinal, but cannot preserve the earlier
current complete-negative certificates. Thus decreasing a discovery cursor is
not a decreasing measure for a successful final current proof. Even granting one
whole 31-fact negative proof for free across requests, stronger than the allowed
record, leaves 465 reads. Fair completed maintenance does not change the local
selected-slot obligation. Finite positive completion for **all** admitted formulas
cannot be promised under these restrictions.

This does not waive existing truthful negatives. A supported complete bounded
selection still proves a negative when its whole current read fits the aggregate
ledger. Complete empty item pairs still prove their specified negatives. Nonempty
historical relation pairs that remain unreadable retain unknown; this report does
not promise them eventual false. The conflict fixture belongs to neither an
unknown-target case nor that deliberately limited historical-pair promise.

## What alternative access structures actually change

The following are analyses of alternatives, not new ports or adopted SQL. They
separate filter interpretation, native order access, and certificate authority.

| Alternative and exact conceptual operation                                                                                                                                                                                       | Boundary under current rules                                                                                                                                                                                                                                                                                                                | Effect on this proof                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectedAfter(route, subject, slot, afterOrdinal, limit, budget)`; SQL selects current native selected identities with ordinal `> afterOrdinal`, ordered by ordinal; outputs raw facts and consumed ordinal                     | Resumes previously consumed native order; does not interpret a range or qualifier. Current ABI already represents this kind of progress. All visited identities and lookahead count.                                                                                                                                                        | Enumerating all 31 still required for each certificate.                                                                                                                       |
| Query-independent index keyed `(route, subject, property, unit, amount, statementIdentity)`; typed input is an already consumed full key plus limit; SQL `key > afterKey ORDER BY key LIMIT n`; outputs data, identity, next key | This is order access, provided extraction uses the single native normalizer and does not evaluate a leaf. It is not in the current cursor ABI, which supports sequence/ordinal/UUID only.                                                                                                                                                   | Reordering does not reduce a whole-slot read. Any final optimization still needs existing coverage.                                                                           |
| Same index with initial input `unit='1', amountStart=100, amountEnd=200` derived from this leaf; SQL bounds by those fields; outputs candidate identities for Search to match again                                              | The physical comparison is a seek, but choosing bounds interprets the leaf's unit/range as a native narrowing predicate. The current explicit no-range-SQL clause cannot be silently bypassed by naming this data access. Whether a deliberately generic initial seek is an authorized exception is an exact Root/Search boundary question. | Even if allowed as narrowing, an empty bounded range is neither existing coverage kind.                                                                                       |
| SQL `amount BETWEEN gte AND lte AND unit = unit`, plus `EXISTS` for requested qualifiers joined on the same statement                                                                                                            | Native query-dependent range/unit/qualifier evaluation. A final Search matcher does not erase that earlier interpretation. Prohibited by the quoted clause today.                                                                                                                                                                           | Requires both an interpretation exception and new complete-disjointness semantics; no current proof.                                                                          |
| Query-independent selected extrema or a complete ordered selected-data tree; read min/max/count or authenticated gap nodes                                                                                                       | Stored native data/locators can be useful and need not be permission stores. Search could in principle interpret normalized data or gap evidence. Current `IndexedStatement[]` plus the two coverage kinds has no such complete-disjointness evidence.                                                                                      | Could cheaply answer this particular mathematical negative, but that is a changed certificate, not `selection`. No all-shape quantitative bound follows from naming the tree. |
| Existing exact possible-item-pair prefix and empty seek                                                                                                                                                                          | Explicitly permitted special coverage, once synchronous writer and bootstrap completeness are proved for every requested value                                                                                                                                                                                                              | Does not cover quantity/time/code ranges or material qualifiers.                                                                                                              |
| Cross-request shared, query-independent identity/value locators, including existing relation hints                                                                                                                               | Locator storage is not cached Access or truth. Revalidate current selection and relevant foreign authority every time. Charge locator and driver reads.                                                                                                                                                                                     | May help arbitrary positive ordinals; cannot carry the sixteen current false results.                                                                                         |
| Query-specific witness/truth/locator vector in an owner row, encrypted token, digest payload, or server map                                                                                                                      | Prohibited cross-request state, even if opaque or called a cache                                                                                                                                                                                                                                                                            | Not an available operation.                                                                                                                                                   |

An empty seek consumes points and `emptySeeks`, and index-internal physical work
must be measured; zero returned identities is not zero work. Conversely, this
report does not invent a raw fact key for every empty internal B-tree comparison.
The precise owner accounting of native points/rows/bytes is separate from the
fixed raw-identity ledger.

Ledger expansion, stricter admission, retained query-specific proof state, a new
gap/disjointness certificate, and broader native filter interpretation are
**unadopted tradeoffs**. Increasing the ledger just to 288 is not sufficient for
this 496-fact case, nor is 496 sufficient after nonzero outer work. Excluding this
type-anchored NOT shape or declaring all selection negatives permanently unknown
would change the required grammar/completion behavior. No such choice is made.

## The actual shared runtime an owner would have to preserve

This inventory prevents a hypothetical index from acquiring authority by omission.
The conflict proof grants an ideal ready producer; missing integration is not its
reason for failure.

### Selection, normalization, provenance and writers

[`semantic/slots.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/slots.ts)
reads the latest slot operation. Compact slots fold assertions/retractions in
`slots-read-compact.sql`, joining the exact recording revision/release; the native
bound is at most 33 operations including expansion signaling. Expanded Global
selection reads the latest adoption head and uses `slots-read-selection.sql` to
join selected candidate identities with ordinality, at most 32 selected points.
Adopted rank is authoritative; normal and preferred qualify, deprecated does not.
Community-only selection and ambient private overlays do not become public facts.
`globalSlotView` may append rejected/deprecated display facts, so its whole display
DTO is not an evidence set. `slots-read-hidden.sql` also checks disclosure and
terminal retraction, not just hidden-candidate rows.

[`semantic/candidates.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/candidates.ts)
enforces Global replacement adoption, selection count/cardinality, duplicates,
same-slot membership, current acceptance/hide checks, and editorial revision/head
updates. Expansion materializes the compact identities through the same candidate,
acceptance and Global adoption machinery before marking the slot expanded.
`write-facts.ts`, `insert-facts.sql`, `slots-insert-candidate.sql`,
`candidates-insert-candidate.sql`, and `change-current-facts.sql` are actual writer
and count boundaries, including bulk/imported provenance; an index cannot follow
only interactive proposal events.

[`semantic/search-source.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/search-source.ts)
has the shared normalization that should be extracted, not reimplemented: finite
numeric amount/unit, valid safe-integer year, declared patterned-string code, and
item qualifiers from the **same statement**. Its `search-source-facts.sql`,
`search-source-adoptions.sql`, and `search-source-statements.sql` read actual
fact/selection/candidate state; none is an admitted range/qualifier SQL evaluator.
`SubjectSource.read`'s 256 subject-ID bound does not bound raw fact work; its
whole-subject/history read cannot be substituted as one charged leaf key.

### Existing witness producer, bootstrap and repair

At the separately inspected [relation producer pin](https://github.com/rezics/rezics-next/blob/db7cee84736de18473dab16369ff6f7528d3584e/services/kernel/src/semantic/relation-facet-witnesses.ts),
`relationFacetProperties` covers relation facets only. It does not index all
material item/code/time/quantity leaves. The actual possible-history table
`relation_facet_statement` is keyed by route, subject, property, item value and
statement identity; slot and recording-transaction/proposing-revision metadata
locate the native source. This is a superset of possible identities, not current
selection or permission. The identity-access migration adds the actual expression
index used by the typed identity query; merely naming a UUID index is insufficient.

The same pin's
[`20261027061803_relation_facet_witnesses.sql`](https://github.com/rezics/rezics-next/blob/db7cee84736de18473dab16369ff6f7528d3584e/services/kernel/db/semantic/migrations/20261027061803_relation_facet_witnesses.sql)
backfills compact and expanded relation values with native provenance. Its writer
SQL maintains that superset for native insert, expansion, and proposal. The
[`20261027071425_witness_identity_access.sql`](https://github.com/rezics/rezics-next/blob/db7cee84736de18473dab16369ff6f7528d3584e/services/kernel/db/semantic/migrations/20261027071425_witness_identity_access.sql)
and typed `facet-witness-*.sql` were inspected with the producer. Completeness of
these synchronous writers plus old-data coverage is a prerequisite for an exact
empty-prefix certificate, not something a successful repair hint implies.

`relation_facet_witness_value` stores a generation/property/value-to-witness hint.
Publication joins the build's published generation. The build stores requested,
active and published generations, cause position, and a property/value/statement
cursor. Requests coalesce durably; bounded pages stage a first readable identity
per pair, advance atomically, and publish only at end with restart/supersession
checks. Pages are bounded (default 64, allowed up to 256); total maintenance may
grow with historical witnesses. This gives finite quiescent repair under fair
completed work, not constant total repair I/O.

Private `visibleWitnesses` checks compact/Global selection, current candidate and
source provenance, moderation/retraction, disclosure, fences and target visibility.
Its hardcoded normal rank and relation-only normalization need extraction through
the one selection/normalization producer, rather than a second resolver. The
existing match probe tries a saved hint then 32 alternatives and returns true or
`not_proven`; sampled 128-value publication is not a general absence proof. The
owner tip exports rebuild machinery, but its default `worker.ts` does not wire
that consumer alongside the existing relay/link projection. This report grants
completed maintenance, so that integration gap cannot explain away the lower bound.

### Classification of any generalized selected-data index

No generalized index is adopted. If Root commissions one, every stored field must
have the following explicit authority, and cannot be used as a hidden holder or
permission directory:

| Hypothetical stored row/bytes                                                                    | Classification and allowed use                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(route, subject, property, slot, native identity, ordinal)`                                     | Native locator/access structure; not proof of present selection or readability                                                                                  |
| Exact revision/release, adopted rank, normalized amount/unit/year/code/item/qualifier bytes      | Query-independent derived selected data; maintained through one native producer; qualifier association retains statement identity; not permission               |
| Recording transaction or candidate revision and Content tuple locator                            | Provenance locator; does not attest a current tuple fence                                                                                                       |
| Min/max/count/tree node and ordered child locators                                               | Derived data/access structure; must have proved completeness and repair/bootstrap lifecycle; not one charged row that packs many fact reads under today's rules |
| Requested/active/published generation, durable cursor and event checkpoint                       | Maintenance/completeness control, not a current foreign-eligibility vector or reusable leaf truth                                                               |
| Subject/target eligibility, account consent, original/terminal Access or Content-fence allow bit | Current native authority belongs to its own home/owner; must not be cached here as permission                                                                   |
| Query/leaf-specific vector of prior selected facts, witnesses, truth or locators                 | Disallowed continuation/cache state; encryption does not change its classification                                                                              |

A future completeness proof would have to cover initial creation, material edits,
compact retract/assert, expansion, proposal and provenance installation, acceptance
and adoption/revision/rank changes, Global suppress/replace changes, moderation,
disclosure/consent and terminal retraction, imports/bulk writes, release meaning,
merge/redirect/identity changes, old-data bootstrap, and resumption after crash or
supersession. Coalesced durable repair must publish only a complete generation;
backfill racing writers needs an acknowledged catch-up boundary. Existing relation
tables alone prove none of this for generalized material data. These are missing
owner proof obligations, not permission to add duplicate selection truth.

### Foreign authority cannot be observed by a local generation

[`semantic/fences.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/fences.ts)
uses exact proposing-candidate revision or compact recording-transaction provenance.
`candidateSources` and `fencedIds` resolve Content tuple homes and call native
`readFences`, grouping at most 100 tuples per read. Tuple takedown/security revision
can change without any source slot or adoption change. The index may store the
tuple locator; it cannot store a perpetual allow result.

[`semantic/statement-disclosure.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/semantic/statement-disclosure.ts)
distinguishes private audience reads from public source evidence. A foreign target's
visibility/eligibility or account consent can change while the local source's slot
generation remains fixed. Public evidence must observe the relevant native target
and disclosure/retraction authority now. An empty **possible** pair is robust to
such changes only because there was no possible identity at all. Historical
nonempty pairs retain unknown when current absence cannot be proved.

Original Access, actual terminal resolution, source-current eligibility, selected
candidate authority, and final positive checks all remain required. Source-local
basis includes relevant foreign observations for complete selection; witness
progress basis does not certify old rejected witnesses still fail. Foreign-only
restoration behind a consumed UUID requires a fresh traversal or a fresh useful
hint. The structural identity digest is not a snapshot of targets, consent or
fences. Foreign dependency registration/relay/catch-up, if needed for repair, is
an owner dependency rather than a new Access grant. The lower-bound fixture has
no foreign targets or fences, so granting ideal foreign revalidation does not
weaken the conflict.

## Independent budgets, outer composition and promised capabilities

For every dispatch `j`, each actual native axis must satisfy its own reservation:

```text
u_j.keys <= r_j.keys <= min(owner-step allowance, remaining aggregate allowance)
u_j.points <= r_j.points;       u_j.witnesses <= r_j.witnesses <= 100
u_j.rows <= r_j.rows;           u_j.bytes <= r_j.bytes
u_j.emptySeeks <= r_j.emptySeeks
sum_j u_j.keys + K_outer <= 256
N_outer,a + sum_j u_j,a <= N_reserved,a       for each independent native axis a
```

Native keys may be at most 101 including one reserved lookahead; this is **not**
a Zone allowance of 101. A Zone owner step capped at 100 including lookahead must
reserve a fitting smaller native window. Alias/prefix keys, all sources and
candidates, internal fact drivers, rejected/duplicate reads, rereads, final checks
and unused lookahead share the same aggregate ledger. There is no per-source reset.

The conflict requires at least 496 distinct fact observations and at least 496
physical fact/data entries, even before controls and joins. In a path emitting
all those facts, witnesses are also at least 496 across calls; actual bytes are
at least the sum of their observed UTF-8 field payloads, plus native metadata.
Point counts differ between compact range and expanded point paths and must be
measured, not inferred from returned facts. Empty probes also consume their
independent axes. No finite upper bound for a newly generalized index's statements,
blocks, bytes or maintenance is asserted here. Granting unlimited native axes still
does not satisfy the raw-key inequality; constraining them cannot rescue it.

The identity contract separately charges **8192 metadata plus Core observations**
per required identity phase: prepare, continuation and final use. The inspected
identity implementation reads two released-home observations and requires equal
structural bases with pending maintenance settled; it does not obtain a global
transaction or foreign permission snapshot. Per
[`search/README.md`, “Cost: canonical coverage observation”](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/search/README.md),
coverage brackets additionally require two full basis reads, 16,384 metadata plus
Core observations, an unchanged-port comparison of 4096 home/Core observations,
and separately charged coverage points and UUID/alias/protocol reads. Conservative
cold certification uses three full bases, 24,576 metadata plus Core, an additional
4096 home/Core capture and up to 4096 coverage/checkpoint points per poll. These
are native costs, not free digests or credits that offset raw keys. Shared actual
observations may be reused where the real composition shares the read; unrelated
phases cannot be declared shared by reservation alone.

The actual Search Scope source is admission/reservation scaffolding: prepare,
prefix and evaluation callbacks remain unavailable. The delivered Semantic export
is also a stub, not an observed fast path. Neither stub is the conflict or a reason
to stop this research. Production acceptance will need the actual composed reads.

The continuation in
[`search/scope-progress.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/services/kernel/src/search/scope-progress.ts)
is exactly one 18-byte raw record: leaf ordinal, phase, value ordinal and sequence
or UUID. The enclosing position remains the existing eight fields
`[basisDigest, settledCanonicalId, groupId, sourceOrdinal, aliasAfter, sourceAfter,
ownerBasisDigest, formatVersion]`. Pending work retains the actual original in
`aliasAfter` and resumes it before the exclusive next-alias seek. No witness vector,
candidate body, nested token, server map, PIT or cached permission is available.

The Zone remains a UUID union over its admitted sources, not an alternative
ordered search engine. Native `orderedTypeList` requirements remain separate and
unchanged. [`packages/composition/src/reads.ts`](https://github.com/rezics/rezics-next/blob/1f836e3f9c656acb9472b324b52a5766ddb13e34/packages/composition/src/reads.ts)
enforces at most 16 reads and **128 total output-slot cost**. A per-read limit of
24 does not promise 16 times 24 results. Atomic multi-read final replay and shared
cost composition are explicit further Zone/Search obligations. A proof for one
candidate would not prove an entire page; this counterexample already fails for
one candidate with every outer raw cost set to zero.

## Independent native acceptance matrix for any subsequent decision

These are proof/execution obligations for later owner acceptance, not added tests
or a claimed passing native suite. Existing frozen tests are unchanged.

| Shape/change to exercise                                                                      | Current promised behavior and what must be demonstrated                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sixteen quantity slots, 31 facts each, type AND NOT(false OR) above                           | Real pure admission passes; current coverage requires at least 496 keys. Any claimed unchanged-budget completion must identify exactly which certificate clause it changes.                                                                                                  |
| Compact and expanded variants; normal/preferred, deprecated/community alternatives            | Same current selection producer, exact revision/rank/provenance; no history fold or display DTO shortcut. Lower bound survives both representations.                                                                                                                         |
| 32 expanded leaves over 16 facets                                                             | Actual `parseFilter`/`admitFilter` accepts two distinct ranges per facet in an AND; planner has 32 distinct leaves. Sharing a real slot read is allowed, not an assumption of 32 distinct facets.                                                                            |
| 64-value material item and declared code; time and qualified quantity ranges                  | Actual release validation and pure admission passed for item/code 64-value leaves and a time range. A type plus NOT of 15 individually item-qualified quantity ranges passes with 31 admission leaves and 16 deduplicated plan leaves. No qualified relation is smuggled in. |
| Arbitrary matching ordinals and all-positive conjunctions                                     | Query-independent selected-data locators may improve them. No universal impossibility or complete constructive bound is proved for this subset; first-positive sampling or rotating one last ordinal is insufficient.                                                        |
| True AND, false OR, NOT and unknown                                                           | Exact shared planner: complete false coverage is required for each false-OR child; partial facts remain unknown through NOT. A useful positive locator alone cannot cover this matrix.                                                                                       |
| Witness 257 and 4096, only last readable; alias groups 257 and 4096, only last eligible       | Consumed raw UUID continuation reaches last survivor finitely under fixed input; actual original remains pending and resumes first. Every rejected key and reread counts. This is discovery convergence, not an aggregate final-page proof.                                  |
| Complete empty pair for every value in a 64-value item leaf                                   | Prove synchronous writer/bootstrap superset coverage and charge every empty probe and control observation. Any nonempty historical requested pair prevents calling that pair empty.                                                                                          |
| Historical nonempty pairs, all currently unreadable                                           | Null coverage/unknown is allowed even after raw end and completed repair. No generalized negative capability is promised here.                                                                                                                                               |
| Foreign target hide/restore, consent change, Content tuple fence change, unchanged local slot | Fresh current home/Access/fence observations and original/terminal/source final checks; local generation alone cannot certify an old witness or absence.                                                                                                                     |
| Crash, coalesced writer bursts, bootstrap racing edits, release/merge invalidation            | One durable shared producer, complete publication boundary, fair finite repair, explicit not_ready/basis_changed when incomplete; no stale negative certificate.                                                                                                             |
| Native growth and outer composition                                                           | Observe actual raw keys, all five other axes, SQL statements, blocks and controls, identity and coverage brackets, lookahead and final replay; test all sources/candidates under one 256 ledger and the 128-slot planner cap.                                                |

Qualified leaves count qualifiers against the expanded admission budget. The actual
limits are 32 leaves, depth 4, OR 16, values 64, qualifiers 4; material facet types
include `wikibase-item`, declared patterned `string` codes, integer-year time and
unit-bearing quantity. Arbitrary `external-id` fields and qualified relations are
not substitutes for those admitted capabilities. All control releases above also
passed `validateRelease`; the main subject passed both structural and typed input
checks, not just a manually built Search clause.

## Primary external source: what an index can and cannot establish

The existing reference clone was reused read-only at
`.reference/library-shelf-maintenance/postgres`, under the main checkout's allowed
reference directory. Its origin is <https://github.com/postgres/postgres.git>, pin
`700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, licence **PostgreSQL License** in
[`COPYRIGHT`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT).
Source objects were read with Git; nothing from the reference was installed,
built or executed. The reuse is recorded in `.reference/INDEX.md`.

The relevant primary sources, rather than a product analogy, are:

1. [`src/backend/access/nbtree/nbtsearch.c`, `_bt_first`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtsearch.c)
   preprocesses scan keys and chooses an initial B-tree position from boundaries.
   A seek is a real access operation. Which typed values become scan boundaries
   matters; the existence of a generic B-tree does not authorize filter execution.
2. [`src/include/executor/execScan.h`, `ExecScanExtended`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/include/executor/execScan.h)
   separates access-method tuple retrieval from residual `ExecQual`. Rejected
   inputs are still accessed. A small returned result cannot prove small raw work.
3. [`src/backend/executor/nodeIndexonlyscan.c`, `IndexOnlyNext`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeIndexonlyscan.c)
   performs index access and required rechecks. Official
   [PostgreSQL 18 index-only scan documentation](https://www.postgresql.org/docs/18/indexes-index-only-scans.html)
   separately explains data availability and MVCC visibility. Including payload
   is not equivalent to establishing all visibility conditions.
4. Official [multicolumn index documentation](https://www.postgresql.org/docs/18/indexes-multicolumn.html)
   distinguishes constraints that bound scanned index portions from conditions
   that do not reduce that portion. A composite index name alone is no quantitative
   discovery or rejected-input bound.
5. Official [transaction isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html)
   describes repeatable read within a transaction. It does not supply a shared
   cross-home snapshot after releasing clients, or revalidate foreign authority
   in a later request.

The shared pattern is separation of **access path, predicate evaluation,
visibility, and completeness**. Apply that separation in this repository's native
TypeScript/typed-SQL/PostgreSQL stack, retaining one selection/normalization
producer and Search's matcher. No PostgreSQL file, new query engine, permission
cache or reference-project snapshot mechanism is recommended for copying. External
sources explain why neutral seeks and residual matching can coexist; they do not
grant a REZICS range-SQL exception or a new coverage certificate.

## Decision requested and exact dependencies

Root can adopt this restriction conflict without adopting a replacement design:
the universal completion claim cannot be met by the currently defined non-item
negative proof operation and the aggregate256 ledger. The smallest immediate
question is whether **whole-slot-in-this-observation** remains mandatory for
complete negative material evidence. If it does, the universal promise needs an
explicit ledger/admission/completion change. If Root instead permits native
data-disjointness coverage, its semantics, cross-home invalidation, ABI and Search
consumer proof need an owner decision before implementation. This report does not
claim that such permission alone yields a complete 256-key design for all shapes.

Separately, Root and Search must resolve whether a generic initial selected-data
seek with a filter-derived numeric/unit boundary is allowed under the quoted
range-SQL rule. Consumed-key order access and full range/qualifier SQL evaluation
have distinct, explicit operations above; ambiguity in the middle is not Source
authority to choose an exception.

The exact owner dependencies are: Semantic's shared accounted selection,
normalization and evidence producer; synchronous possible-pair writers and old-data
coverage where used; durable coalesced repair and its default-worker lifecycle;
native identity resolution/alias/basis ports; actual foreign target/consent/Content
fence and Access reads; Search's evidence-to-tristate consumer and aggregate cost
composition; and Zone's separate atomic multi-read final replay. No Source-owned
index grants Access changes. Neither missing producer integration nor a failing
baseline native test was used as a reason to leave this report unfinished.

Verification performed for this report: real pure admission/release/subject and
shared matcher/planner executions described above; report formatting and Git
whitespace checks; and the contract's nonempty-report check. No native execution
performance claim, new production test, schema, SQL, wire, policy or ABI change is
made. The only repository change is this report; the permitted external reference
index receives a reuse citation so later work can find the inspected source pin.
