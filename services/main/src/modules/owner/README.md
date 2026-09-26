# Owner maintenance template

`operations.ts` is the owner operation ledger; `../../routes/owners.ts` is its
HTTP boundary. The relay migrations 012 and 013 own the row constraints. Main
uses a writable relay session for these operations and its separate read-only
session for backpressure. Account discovers the `owner:operate` operator OAuth
scope from `services/account/src/oauth-scopes/owner.ts`. Main checks the current
Access principal for ordinary owner requests. While Access is fenced for a
restore, this route checks the active principal row directly against the fenced
Access owner after Account verifies the scoped bearer token.

Restore reconciliation accepts the retained signed coverage and an ordered list
of signed deletion recovery sets. The server holds the HMAC key outside the
request and compares Account WAL/rows, Access authority and outbox, Content
revision pins and rows, graph references, immutable objects, relay batches and
the retained current coverage head. A matching pass records six owner cuts and
releases the graph hold through the idempotent graph receipt. A mismatch records
a held finding. The request key binds both the coverage and deletion-set list;
a repaired cut needs a new key. A crash after graph release but before the relay
outcome can resume the running pass with the same key.

The revision reconciliation template reads one exact Work anchor and its
immutable manifest/payload, records one append-only finding and one verified
graph cut, then settles the relay pass. A missing or corrupt exact object leaves
the pass held. A retry of the same operation key returns the settled result; a
new key makes a new pass after repair. A crashed `running` pass resumes on the
same key. The operation never substitutes HEAD or releases a restore hold.

Relocation stages one exclusive owner-dataset move. An operator copies the TDB2
dataset and referenced immutable objects to the configured target while the
source still serves reads. Activation fences the source with a new graph epoch
and hold, compares all named-graph facts outside local control/maintenance
receipts, verifies every referenced manifest and payload, and checks the
erasure journal. The target graph activates at its own new data/routing epochs
before the Access route CAS increments the lease epoch. The target hold is
released only after that CAS. The `relay.owner_relocation` row records the
final source position and anchor/object evidence; no second relocation ledger
exists. A retry resumes after a missing target object, a graph cutover, or the
route CAS. Old workers are rejected by the Access route/lease check and by the
source graph epoch/hold even if they lack the new route check.

The `retention_gc` pass runs only on a fenced old local placement. It verifies
all graph manifest references, including retained anchors, and protects their
transitive payloads before deleting unreferenced digest files older than 24
hours. It records preserved and retired digests in the reconciliation ledger.
The old graph remains held after a move; ordinary TDB2 compaction never performs
object GC. S3 namespaces are not listed or collected by this local pass.

The `relay_gap` pass verifies the full durable relay handoff, then copies at most
100 contiguous batches of exact envelopes to the Access-owned replay inbox in
one transaction. Its inbox checkpoint advances with that copy. This is a
product-owned replay source after broker/source retention loss; downstream
effects consume the retained envelopes with their own idempotent receipts. A
missing retained batch leaves the reconciliation held and does not advance the
inbox checkpoint. A crash after Access commit resumes against the exact rows
before the relay pass settles.

Cost contracts: restore reconciliation scans the participating owner rows and
relay history once, plus Q graph quads and B referenced object bytes; object
scan memory is O(M + largest object) for M graph manifest references. The graph
query has Fuseki's read deadline, and a partial scan fails capture. Its
operation-key and retained-head reads use relay unique indexes. The coordinated
owner fault test exercises matching and mixed owner cuts, including graph,
Content, Access, Account, relay and immutable objects. Corpus-scale object
transfer and native scan counters remain unqualified.

Revision reconciliation performs one indexed relay operation
lookup, one exact anchor graph lookup and at most four immutable object attempts
(S3 then filesystem fallback);
settlement writes at most one pass, cut and finding. The path has no history
walk or unrelated-owner scan. Relocation staging performs one unique-index
insert and one operation-key lookup. Its cutover reads two O(Q log Q + B)
placement snapshots under a 16 MiB graph response cap, plus indexed Access
route and relay row checks. Memory is O(Q + largest object). Relay-gap recovery
does one O(N) retained coverage scan followed by O(K + E) indexed reads/writes
for K <= 100 batches and E events. Local retention GC costs O(Q + B + F log F)
for Q graph facts, B referenced object bytes and F local files. These bounds
are exercised by the route tests and their indexed SQL plan checks.
`owner-operations.test.ts` exercises the
actual relay indexes and exact object outcomes; TDB2 compaction has a separate
offline fault test. Offline compaction copies the current Q RDF quads once,
O(Q) engine work and O(Q) replacement disk, while retaining the prior generation
for the recovery window. The fault test measures the pinned image at one and
five Works, rejects unexplained superlinear growth, and proves old exact history
after the inactive generation is removed from its isolated QA copy. It does not
measure corpus-size disk headroom or elapsed compaction time.
