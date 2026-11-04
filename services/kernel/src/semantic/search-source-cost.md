# Search current nonrelation source heads

This derivation is the mounted Semantic Search-source read in
[search-source.ts](search-source.ts): `subjectSource(pool).read(partition, ids)`.
It is the H(id) term [retained facet composition](../search/cost-retained-facets.md)
already charges. Do not raise that composition's caps or treat this file as a
successful Search page acceptance.

Decision: use a dedicated partial index keyed by `(route, subject_id, property, slot_id, candidate_id)` with predicate `active AND relation IS FALSE`; keep the general active index for other readers.

Decision: unreadied `search_selection_state` is `CommandUnavailableError('contention')`
after one `search_rebuild_one` outside the read-only snapshot. Ready-empty remains an
empty statement list. An overflow lookahead on a ready Subject is the same unavailable
signal without rebuilding. Expanded Global heads use the stored `search_selected`
body, rank and release, not a second fold of `semantic.adoption` or `semantic.candidate`.

## Units

Let `B ≤ 256` be the submitted Subject batch (`read` refuses a larger id list before
deduplicating it), `S ≤ 512` be the admitted current nonrelation facts per Subject,
and `C ≤ 32` be the admitted Global adoption selection per expanded slot. `C` applies
where the expanded-selection code enforces it; compact slots retain their existing
32-record bound. Obsolete fact revisions and active relation degree are not terms of
this projection.

The ordered seek is `(route, subject_id, property COLLATE "C", slot_id, candidate_id)`:
route and subject are equalities from the requested batch, followed by the exact SQL
order. `search_selected_nonrelation_page` contains only rows where `active` and
`relation IS FALSE`. Inactive rows and relation heads are absent from this access path before
the query's finite lookahead. The general `search_selected_page` remains available to
other readers. A `LIMIT` after filtering an active-only index or scanning `fact` history
is not this bound.

## Ready read

A ready snapshot, with current facts and the response window fixed, does this native
work per call:

| Seek                            | Access path                                                                                                                                                                            | Live rows                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Partition position              | `core.partition` by partition                                                                                                                                                          | 1                                                                            |
| Requested Subjects              | `subject_pkey` plus `search_selection_state` readiness                                                                                                                                 | `≤ B`                                                                        |
| Current terms                   | `current_term_fact` via term heads, not statement history                                                                                                                              | current term slots                                                           |
| Current nonrelation statements  | `search_selected_nonrelation_page` equality `(route, subject_id)`, predicate `active AND relation IS FALSE`, ordered by `(property, slot_id, candidate_id)`, `LIMIT S·C+1` per Subject | at most `B·(S·C+1)` selected index rows, including one lookahead per Subject |
| Disclosure / lifecycle / fences | existing point joins on those returned heads only                                                                                                                                      | `O(returned heads)`                                                          |
| Definition releases             | exact digest points for the returned pins                                                                                                                                              | distinct digests on the page                                                 |

The per-Subject seek reads at most `S·C+1 = 16,385` selected rows. Across the largest
submitted batch this is `B·(S·C+1) = 4,194,560` index rows. A successful read returns
at most `B·S·C = 4,194,304` current statement heads; if any Subject supplies the
lookahead, the whole read returns contention instead of a truncated result. This is
the derived physical row ceiling, not a claim that every read reaches it. The complete
index key and partial predicate ensure relation heads cannot add rows before it.

The projected statement UTF-8 payload is at most `B·S·C` `IndexedStatement` values;
the term payload is at most `B·S` current facts. Encoded bytes therefore scale with
those row ceilings times the existing per-value UTF-8 limits enforced by the selected
release and statement validators, plus bounded Subject and control fields. The fixed
value window does not grow with relation degree. The growth test also requires the
actual serialized Subject payload and measured database response bytes to stay
constant as only relation heads, obsolete history, and unrelated population grow.
The obsolete fact count does not appear. Rejection, Access, transaction
`BEGIN`/`COMMIT`, and the one-step cold fold are charged separately. A ready Subject
with no selected rows is complete-empty.

If the per-Subject nonrelation seek returns the overflow lookahead, coverage is
preparing, not a truncated public page. Ready overflow does not rebuild. Unreadied
coverage performs the existing single `search_rebuild_one` step after the read-only
snapshot, then returns contention; no history fold or maintenance loop runs inside a
read. The separate relation extractor retains its existing 1,000-key and 128-values
per-property controls.

## Cold fold

New Subjects insert `search_selection_state` ready. Old Subjects resume through
`search_rebuild_one(route, subject_id)`, which folds one fact or adoption and keeps
its cursor. The insert trigger already serializes that Subject's selection-state row.
A read-only snapshot must not loop rebuilds. Charge each fold step on its own visit;
do not attribute the historical rebuild to a later ready read.

## Currentness

`search_project_fact` / `search_project_adoption` maintain the same table Search
reads. A lower-`log_seq` late assert cannot overwrite a later head
(`log_seq < EXCLUDED.log_seq`) and cannot pass a later retraction. Lifecycle
deletion, hidden candidates and withheld disclosure remain read-time exclusions;
they never enter public output. Non-Global Context adoptions are not this projection.

## Growth

`test/semantic/growth-search-source-current-visit.test.ts` holds the requested keys'
current facts and response window fixed, grows active relation heads on the requested
Subject, obsolete history on the requested keys, and unrelated Subjects through
64/512/4096. At each scale the native plan must use
`search_selected_nonrelation_page`, with the complete route-and-subject equality and
no rows removed by a relation filter. The relation entries are absent from that
partial index before lookahead; the returned `LIMIT` alone is not evidence. Setup
failure is unmeasured.
