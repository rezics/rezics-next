# Structure command template

The Book route was the first Structure command family. Every owner registers
`modules/<owner>/structure-profile.ts`; discovery supplies its roles, edit
permission/action, receipt family and target-selection policy to the shared
admission, guarded-write and exact-read paths. The profile separates the
authorized owner from the component named by `rv:structureOf`. Book keeps its
Work/Main Version adapter; Zone, Collection and Recipe can own the component
directly and link their Structure with an owner-specific predicate. Add each
profile shape to `model/definitions/structure-*.ts`. Declare catalog target
types and qualifier projection, hydration and profile validation in that owner
file; the shared command and exact read consume it.
`graph.ts` owns bounded current generation queries; `tree.ts` owns immutable
record, order and pin pages. Main injects the S3 immutable-object adapter with
the separate `semantic/structure/` RustFS prefix before serving requests.

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

The Book path authorizes target resources independently and retains private
progress by occurrence. The seal pins publicly eligible Content variants and
an exact read returns the retained pins; it does not infer a private reader's
Realm. `stage.ts` provides RustFS record-page upload, a lease-fenced Content DB
checkpoint, resume, seal and cancellation. The manifest builder caps a stage at
4,096 records. The activation route rechecks the
Structure head, Work edit grant and every target read grant before it switches
the selected generation with a graph receipt. Activation projects at most 30
records per graph receipt (below the 100-focus command bound), checkpoints each
committed batch in Content, resumes from that checkpoint, and switches the
selected generation only after the complete manifest is projected. Cancellation
after graph start records a graph receipt and marks the unselected generation
cancelled; it never changes the active head.
Context-specific variant resolution and whole-Structure export remain separate
work. The export clause belongs to G-092's export owner.
