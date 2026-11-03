# Private saved Collection member evaluation cost

This derivation covers `createCollectionReads().readMembers` selecting a stored private dynamic Collection,
then `readDynamicMembers` and the native owner-working Source. It includes the wrapper around the common
filter reader. It does not cover public/unlisted COMPLETE output, publication, FULL summaries or command writes.
Engine-invisible multiversion work is outside the adopted examined-work criterion.

**Status: incomplete derivation; native growth is unmeasured.** The row constant for the unidentified-label
probe below is not supported by the current indexes. Consequently neither a composed numeric row ceiling nor
a passing saved-query growth report is asserted here. Existing primitive, ad-hoc query and rule-command
measurements cannot fill this gap.

Decision: keep the composed saved-query read unmeasured until its unidentified-label probe has an indexed
bound and the complete native first/deep/terminal/refusal capture has run; do not substitute ledger ceilings.

## Structural inputs

Let `M` be total canonical membership, `N` the relevant relation population, `p` the requested page size
(`1..100`), `c` the consumed candidate count and `r <= p` the returned subject count. These are different
quantities. Source prefix membership can consume and withhold originals before the filter reader sees a
candidate; its work belongs to the page even when `r=0`.

The shared parser's `FILTER_LIMITS` in `packages/filter/src/filter.ts` bounds expanded leaves to 32, depth
to 4, OR operands to 16, IN operands to 64 and qualifiers to 4. Saving compiles the expanded native plan.
Reading the stored rule preserves its immutable release; an additional filter is combined and re-admitted
under that release. Neither the result size nor a current catalogue release can redefine the saved meaning.

`owner-filter-plan.ts` makes at most three refill rounds, with prefix candidate quota
`q_i = min(100, 2*(p-r_i)+1)`. Thus emitted prefix candidates total at most
`3*min(100,2*p+1)`. This is not a bound on all raw work: prefix itself seeks canonical groups, probes current
original support, resolves subjects, reauthorizes and can withhold candidates. Those steps consume the same
nonrenewed native reservation.

For each complete candidate closure, `owner-filter-native-closure.ts` requires at most 100 canonical raw
keys, `originalIds.length + keys.length <= 100`, and a strictly incomplete fact window within its remaining
100-key closure capacity. A full fact window is unknown and returns unavailable. The canonical group loop
requires progress on every nonterminal page and rejects more than 100 keys. A final empty group seek is work,
not evidence of a free read. These limits bound admitted closure expansion, not historical label rows skipped
by a filtered index scan.

## Composition before a numeric ceiling

Use additive cost vectors `(examined rows, statements, blocks)` for every entry below. Transaction controls,
time queries, failed work and concurrent/background statements must be included. This inventory applies to
a successful ordinary private page without an additional catalogue predicate; errors use the reached prefix
of the inventory. A predicate with catalogue leaves additionally pays both Semantic evidence reads per leaf
and the native query-join/reduction checks.

| Component                        | Exact composition or structural cap                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial built-in selection       | One `builtins.read`, including its actor account point, state-reference miss and read-only transaction. A saved UUID is not a built-in ID.                                                                                                                                                                                                    |
| Collection selection/currentness | Three `loadCollection` calls: initial selection and one after each saved-rule authority bracket. Each owns a read-only transaction, Access decision, current viewer account, Collection header and nonpublic curator account checks. Public eligibility can supply the header to the sink; do not double count it or omit its executed query. |
| Stored definition                | One `readSavedCollectionRule` point inside its own read-only transaction, comparing both Collection revision and sourceGeneration with the selected header.                                                                                                                                                                                   |
| Immutable meaning/admission      | One `readRelease` invocation for the saved digest; `finishCollectionMemberAdmission` checks current actor/authn epoch, then each distinct private-family exposure gate. Count a cache-hit existence query; a cold or composed release takes its actual lookup path.                                                                           |
| Saved-rule authority             | Two `prepareCollectionRuleAuthority` passes, each followed by a read-only transaction evaluating all checks. At most three distinct read actions per pass. The second pass uses a freshly minted time.                                                                                                                                        |
| Native private-family authority  | Initial binding plus both `revalidateNativeOwnerFilter` calls each prepare/evaluate the distinct list actions. At most three families per pass; the initial admission also pays their exposure gates. Read actions and list actions are separate checks.                                                                                      |
| Native binding/currentness       | Direct metadata reads at initial bind and both native revalidations; three active-release points; initial scope lookup; initial and two revalidation owner-fence points.                                                                                                                                                                      |
| Source preparation               | Five `Source.prepare` calls: initial binding, binding revalidation, page start, page final revalidation, final native revalidation. Each includes metadata, authorization and canonical readiness; these are ready-source checks, not a canonical build.                                                                                      |
| Scoped currentness               | Two native revalidation calls plus the page-start scoped revalidation: three in total. Compare captureId and committedRevision as well as Source identity.                                                                                                                                                                                    |
| Candidate execution              | Up to three prefix calls, every internal seek/probe/disclosure, one explicit containsSubject per emitted candidate actually consumed, complete closure reads, and the matcher transaction per matching attempt.                                                                                                                               |
| Final disclosure                 | Resolve every retained original, including exclusion/order/nonmatching support, then repeat native Source/family/scope currentness. Count both original and terminal subject authorization even when their IDs coincide.                                                                                                                      |
| Time/lifetime                    | Binding mints its owned time; final saved-rule authority mints another. Access/Source descendants can issue their own time/control SQL. Final time is released in its inner finally; binding time is released by the outer finally, including reached errors. Failed binding releases its unretained time.                                    |

In particular, if `L` denotes a complete `loadCollection`, `B` built-in selection, `D` definition lookup,
`A` saved admission and `H` one saved authority pass, the wrapper contributes
`B + 3*L + D + A + 2*H + finalTime` on top of binding and bound-page execution. `D` has one SQL point and two
transaction controls. The two authority transactions add four controls before their checks; the three `L`
transactions add six. These are statement constants, not a complete wrapper ceiling: `B`, `L`, `A` and `H`
still include their actual Access and release callees. Do not replace them with the ad-hoc reader's allowance.

The native code reserves `(8192 rows,128 statements)` around a subject disclosure or a private-authority
composition, `(32 rows,6 statements)` around scoped currentness, and `32*h+32` rows for a fact window of size
`h`. These are declared reservations. A reservation around a query that can scan unbounded history is not
a derivation of its observed examined work. In particular `scopeAllowance(100)` is not an end-to-end numeric
growth assertion, and its 65,536-row/8,192-statement compatibility ceilings exclude the outer wrapper.

## Equality prefixes and ordered seeks

These are source/index arguments, not observed plan claims. A unique point examines constant live rows;
an ordered batch of `k` rows has `O(k)` row work and `O((k+1)*log(2+N))` B-tree block work, provided residual
filters cannot skip an unbounded population. Sort/materialization/join nodes add their own examined rows.

| Read                             | Equality prefix and order supported by schema                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection header and saved rule | `collection_pkey(route,collection_id)`; state/kind checks apply to at most one row.                                                                                                                                                     |
| Built-in reference               | `builtin_collection_reference_pkey(route,collection_id)`; no historical tuple walk on a saved-ID miss.                                                                                                                                  |
| Owner fact fence                 | `fact_source_head_pkey(route,account_id)`.                                                                                                                                                                                              |
| Scope binding                    | `canonical_source_scope_pkey(route,collection_id,source_fence)`.                                                                                                                                                                        |
| Canonical head/generation        | `canonical_source_head_pkey(route,collection_id)` and generation PK `(route,collection_id,generation)`.                                                                                                                                 |
| Canonical next subject           | `canonical_source_reference_pkey`: equality `(route,collection_id,generation)`, then strict `canonical_subject_id > after`, ordered by canonical subject, stored subject, driver, fact. `LIMIT 1`; no OFFSET.                           |
| Canonical original group         | Same PK with canonical subject also equal, then strict tuple `(stored_subject_id,driver,fact_id) > after`, bounded LIMIT before hydration.                                                                                              |
| Entry fact                       | `entry_pkey(route,account_id,subject_id)`.                                                                                                                                                                                              |
| Reserved label facts             | `label_assignment_reserved_source`: equality `(route,account_id,subject_id)`, order `assignment_id`, partial predicate `slot_no IS NOT NULL`. Unique reserved slots are `0..31`; deleted rows must release slots.                       |
| Session facts                    | `progress_session_raw_source(route,account_id,subject_id,session_id)` supplies the exact prefix/order without sorting all retained sessions.                                                                                            |
| Live copy facts                  | `copy_live_raw_source(route,account_id,subject_id,copy_id)` supplies the prefix/order and `deletion_id IS NULL` partial predicate.                                                                                                      |
| Definition size/body             | `definition_release` digest point at route 0; closure's `acceptedRelease` first reads size/compression in the same snapshot, then reads an uncomposed release under byte admission. Saved admission's `readRelease` is a separate call. |

## Missing row derivation and production handoff

The first branch of `owner-filter-native-closure-facts.sql` is executed even for a state-only predicate:

```sql
WHERE a.route=i.route AND a.account_id=i.account_id AND a.subject_id=i.subject_id
  AND a.deleted_at IS NULL AND (a.slot_no IS NULL OR a.assignment_id IS NULL)
ORDER BY a.label_id LIMIT 1
```

`label_assignment_pkey(route,account_id,subject_id,label_id)` provides order but does not exclude retained
deleted rows. `label_assignment_reserved_source` and `label_assignment_reserved_slot` require nonnull slots,
so cannot serve this branch. `label_assignment_purge_due` contains deleted rows, the opposite predicate.
The schema requires every deleted assignment to have a null slot, permits null slots for live assignments,
and caps only nonnull slots. Distinct deleted labels for the same original can therefore grow independently
of its live 32-slot population. There is no index here on the live unidentified predicate.

On a negative probe, finding zero qualifying rows can examine the whole retained original-label prefix.
Neither `LIMIT 1` nor the outer `32*h+32` reservation bounds that examined population. This is engine-visible
filter work, not excluded multiversion maintenance. A compliant finite constant for this branch needs an
indexed negative seek or a separately proved structural cap on that entire prefix. Commerce owns that
production correction and its migration; this derivation does not prescribe a second Source or ledger.

Other components still need their complete native Access, identity, release and preparation constants composed
before a numeric ceiling is adopted. Their reservations alone are not supplied as missing proofs.

## Preparation and remaining growth check

`collection-source.ts:ready` requires `readCanonicalSourceState` to return ready; unbuilt/stale native state
throws dependency_unavailable. Binding creates no capture or repair. This failure cannot be treated as an
empty page or silently repaired by fixture SQL. A ready-page fixture may settle the actual producer outside
capture and report that work separately, retaining its exact failure if settlement cannot finish.

After three insufficient refill rounds, `prepareSparsePage` reserves exactly one native preparation episode
through `members-preparation.ts` and returns preparing. It does not prove a ready page or a bounded total
build. The finite step, queue/background and eventual completion costs need separate native capture; a
100-iteration polling helper is not a one-page sample. No preparation work has been measured by this document.

The remaining dedicated test must start with `createCollectionRulesFixture`, real Auth, command-created rule
and admitted facts. Fix a private fact predicate and page size at all scales 64/512/4096. Independently grow
selected source depth, unrelated rules and retained fact/receipt history, checking actual populations and
retained identities. Include same-original retained label history for the missing negative-seek derivation.
Rebuild deep/terminal opaque cursor witnesses after generation changes outside each page capture. Measure
first, strict deep, terminal/empty, reduced-scope and wrong-curator calls through the real measured runtime pool;
assert useful exact membership and reached operation coverage. Include discarded/withheld and background work,
relation footprints and native plans. Missing counters or zero reached cases remain unmeasured. Adopt numeric
row/statement ceilings before samples; use logarithmic blocks rather than wall time.

## Sources consulted

The implementation trace uses `collection-reads.ts`, `collection-rules.ts` and its read SQL, `owner-filter.ts`,
`owner-filter-plan.ts`, `owner-filter-native-binding.ts` and its scope/fence SQL, `owner-filter-working-source.ts`,
`owner-filter-native-closure.ts` and its facts/population/release-size SQL, `collection-source.ts`,
`collection-source-native.ts`, `canonical-source-store.ts`, `builtin-runtime.ts`, `subject-anchor.ts`,
`members-preparation.ts`, `search/scope-execution.ts`, `semantic/definitions.ts`,
`semantic/identity-scoped-observations.ts`, `access/gates/admission.ts`, the shared filter limits and
`db/library/schema.sql`. The sibling Semantic, Access and Search paths are read-only dependency references.
The comparison fixtures/checks are `collection-rules-growth.test.ts`, `owner-filter-growth.test.ts`,
`canonical-source-runtime-growth.test.ts`, `native-dynamic-growth-fixture.test.ts`, their linked Library
support fixtures, `collection-rules.test.ts`, and the shared growth/cost interfaces. These comparisons establish
which operations they call; they supply no saved-wrapper measurement.
