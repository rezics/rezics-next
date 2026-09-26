# Structure command template

The Book composition route is the first Structure command family. Copy the
request validation and Account/Access admission in `change-admitted.ts`, the
receipt, sequence, outbox and profile validation pattern in `change.ts`, and the
exact manifest read in `read.ts`. Register a new profile shape and extend the
role/target checks in `format.ts` before adding another Structure profile.
`graph.ts` owns bounded current generation queries; `tree.ts` owns immutable
record, order and pin pages. `objects.ts` currently uses the Main object's local
directory under a separate `structure/` namespace.

Every edit carries an expected Structure head. Inserts allocate occurrence IDs
from the admitted operation identity; moves keep the ID. A change touches at
most 16 requested placements plus one order segment of at most 32 siblings per
rebalance. Its declared local cost is `pagesRead`, `pagesWritten`,
`placementsWritten`, `segmentsWritten` and `rebalanced` in the response. An exact
read pages at most 100 children from the immutable revision root and reports
page reads. A whole Structure seal is limited to 4,096 placements; larger seals
need the stage job in `stage-schema.ts` and migration 030.

Copy `tests/qa/integration/structure-composition.test.ts` for real admission,
replay, stale head, immutable read and graph validation checks. Copy the page
growth test in `services/main/tests/structure-schema.test.ts` for fan-out and
copy-on-write bounds. A new operation must also prove its target authorization,
graph projection focus set and recovery from a lost response.

The Book path currently authorizes and resolves Work targets only. Content
resource target disclosure, context-specific variant selection, progress storage,
fixed-release integration and whole-Structure export require their respective
owners before BOOK01–BOOK03 and COMP01 are complete. The seal pins only publicly
eligible Content variants and reports missing coverage; it does not infer a
private reader's Realm. A rebalance that would touch more than 100 graph
subjects is rejected with a typed too-large outcome until the staged generation
path handles it.
