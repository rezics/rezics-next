# Owner maintenance template

`operations.ts` is the owner operation ledger; `../../routes/owners.ts` is its
HTTP boundary. The relay migrations 012 and 013 own the row constraints. Main
uses a writable relay session for these operations and its separate read-only
session for backpressure. `owner:operate` is the operator OAuth scope; Account
must issue it before these routes are usable by a real caller. Main also checks
the current Access principal before any owner mutation or read.

The revision reconciliation template reads one exact Work anchor and its
immutable manifest/payload, records one append-only finding and one verified
graph cut, then settles the relay pass. A missing or corrupt exact object leaves
the pass held. A retry of the same operation key returns the settled result; a
new key makes a new pass after repair. A crashed `running` pass resumes on the
same key. The operation never substitutes HEAD or releases a restore hold.

Relocation currently stages a single exclusive owner-dataset move. The request
cannot provide copied-object evidence or activate routing. Activation needs a
separate offline owner procedure that verifies the final source frontier,
anchor and object digests, erasure epoch and exact old reads before changing
the routing/data epochs. Do not treat a `staged` row as a moved dataset.

Cost contracts: revision reconciliation performs one indexed relay operation
lookup, one exact anchor graph lookup and at most four immutable object attempts
(S3 then filesystem fallback);
settlement writes at most one pass, cut and finding. The path has no history
walk or unrelated-owner scan. Relocation staging performs one unique-index
insert and one operation-key lookup. `owner-operations.test.ts` exercises the
actual relay indexes and exact object outcomes; TDB2 compaction has a separate
offline fault test. Offline compaction copies the current Q RDF quads once,
O(Q) engine work and O(Q) replacement disk, while retaining the prior generation
for the recovery window. The fault test measures the pinned image at one and
five Works, rejects unexplained superlinear growth, and proves old exact history
after the inactive generation is removed from its isolated QA copy. It does not
measure corpus-size disk headroom or elapsed compaction time.
