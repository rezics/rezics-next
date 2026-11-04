# Search current nonrelation source heads

This derivation is the mounted Semantic Search-source read in
[search-source.ts](search-source.ts): `subjectSource(pool).read(partition, ids)`.
It is the H(id) term [retained facet composition](../search/cost-retained-facets.md)
already charges. Do not raise that composition's caps or treat this file as a
successful Search page acceptance.

Decision: unreadied `search_selection_state` is `CommandUnavailableError('contention')`
after one `search_rebuild_one` outside the read-only snapshot. Ready-empty remains an
empty statement list. Expanded Global heads are the `search_selected` rows, not a
second fold of `semantic.adoption` history.

## Units

Let `B ≤ 256` be the existing raw Subject batch (`read` refuses a larger id list).
Let `S ≤ 512` be `current_facts`, the admitted current-slot budget per Subject.
Let `C ≤ 32` be the admitted Global adoption selection per expanded slot.
The compact-slot 33-record log and the 32-entry adoption array are local slot
bounds; they do not budget a whole Subject. Obsolete fact revisions are not a
term of this projection.

`search_selected_page` is `(route, subject_id, property, slot_id, candidate_id) WHERE active`.
Inactive retained rows are absent from that index before `LIMIT`. A `LIMIT` after a
`fact` history scan or after sorting inactive `search_selected` rows is not this bound.

## Ready read

A ready snapshot, with current facts and the response window fixed, does this native
work per call:

| Seek | Access path | Live rows |
| --- | --- | --- |
| Partition position | `core.partition` by partition | 1 |
| Requested Subjects | `subject_pkey` plus `search_selection_state` readiness | `≤ B` |
| Current terms | `current_term_fact` via term heads, not statement history | current term slots |
| Current nonrelation statements | `search_selected_page` equality `(route, subject_id)`, `active`, `NOT relation`, `LIMIT S·C+1` per Subject | `O(B S)` compact heads plus at most `C` selected candidates per expanded slot |
| Disclosure / lifecycle / fences | existing point joins on those returned heads only | `O(returned heads)` |
| Definition releases | exact digest points for the returned pins | distinct digests on the page |

Physical selected rows are `O(B S + C_returned)`, with `C_returned ≤ B S C` only as the
product of already admitted write caps, not a new ceiling. The obsolete fact count
does not appear. Rejection, Access, transaction `BEGIN`/`COMMIT`, and the one-step
cold fold are charged separately. A ready Subject with no selected rows is
complete-empty.

If the per-Subject active seek returns the overflow lookahead, coverage is preparing,
not a truncated public page.

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
current facts and response window fixed, grows obsolete history on those keys, and
grows unrelated Subjects through 64/512/4096. Native plans must use `search_selected_page`
(or an equivalent active prefix) without materializing `semantic.fact` statement
history or sorting inactive heads before the row limit. Setup failure is unmeasured.
