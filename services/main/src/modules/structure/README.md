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
An owner with a non-Work target declares `authorizeTarget` and any required
`targetReadPermission` in its discovered profile. The shared admitted change,
seal, restore and stage paths call that current disclosure decision for each
native target. Owner read routes pass the same decision to `readCompositionPage`
and `readCompositionSeal`; catalog targets remain declared public terms.
The cost is one authorization check per distinct inserted target and one per
returned target on paged reads or seals, bounded by the existing page/placement
limits. A missing callback retains the Book Work disclosure behavior.

`bootstrapAdmittedStructureOwner` composes an owner module's validated,
receipt-returning create command with the existing admitted Structure create.
Both subcommands receive deterministic operation keys derived from one caller
key. The owner step must return its durable success receipt and request digest;
the Structure step runs only after that proof. Retrying after either command
replays its receipt and completes the other step. This uses two bounded owner
commands and no scan or compensating deletion; a failed Structure step leaves
the independently created owner available for a retry.
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

Recipe measure replacement accepts at most 64 format-checked measures and one
expected head. It reads one root manifest, writes one new root while reusing its
record and order pages, and commits one revision, receipt and outbox event under
the head CAS. Exact measure reads fetch one revision anchor and one manifest;
they never use the current projection for an older revision. The result reports
one page read and one page write for a committed edit, with zero placement,
segment and rebalance writes. A stale head records a terminal rejection.

Book import and refresh read the exact source revision, retained source basis
and expected local head, with at most 4,096 records in each. Source keys map to
stable destination occurrences; the three-way planner counts comparisons and
reports simultaneous divergent content, removal, order or child correspondence
as a conflict. A planned result is checkpointed as immutable stage pages before
the existing lease-fenced activation. Each graph projection receipt contains at
most 30 records, and the final head switch uses the expected head. Planning
cost is O(n log n) for at most three bounded record sets and O(n) memory;
activation retains the stage's per-batch cost. Replays use the stage key and
graph receipt rather than rebuilding an already activated result.

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
