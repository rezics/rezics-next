# Access authority control extension

The first real write/read template is `AccessTopology.changeEdge` and
`AccessTopology.readEdge`, exposed through `routes/access-topology.ts` and tested
by `tests/qa/integration/access-topology-api.test.ts`. Copy its input validation,
`controlTransaction`, gate lock, principal/mandate/ceiling checks, `receipted`
effect, typed error mapping and owner read for another control family. Extend
the owner schema and migration test before adding another write. A receipt is
scoped to the principal, key, intent digest, family, operation and object; an
exact replay returns the saved result. Writes take the relevant scope gate
before comparing epochs and then change the effect and receipt in one transaction.

Cost contract for these v1 operations: exact identity reads use indexed primary
or composite keys and return one bounded result. An edge write takes one topology
gate row and checks at most 257 reached subjects; degree is capped at 16. One
admission contains at most eight obligations and eight edges each. Policy rosters
are capped at 256, protected role rewrites at 256 live bindings, dependent grant
lineage at depth eight and 256 descendants per root, and approval sets at eight.
The schema test exercises cycle, degree, fan-out, protected and continuity bounds;
the API test exercises admitted path, denied cycle, stale proof and dependent
revocation. These bounds are request work limits, not deployment latency claims.

Selected grant revocation consumes one admission and its one assignment obligation
inside the grant owner's transaction. It reads one admission by primary key, at
most nine obligation rows (the ninth detects an invalid oversize set), at most
eight saved path steps per obligation, one target grant by primary key and one
receipt by `(principal_id, idempotency_key)`. The receipt has a unique partial
index on `selected_admission_id`; an exact replay reads the prior receipt before
the proof check, while a new key must pass the current epoch and live proof.
The read route looks up one selected receipt and joins one principal and grant.
The IAM27 API test checks the physical selected-receipt lookup at 64 and 16,000
unrelated rows with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`: the large volume
must use the selected-admission index and read at most 12 shared blocks. The
recovery fence denies a new effect while Access is held, and a revoked saved
edge still denies it when the fence reopens.

The API fixtures also exercise physical indexed lookups with 16,000 unrelated
invitation, grant-lineage, representative-policy and protected-proposal rows.
Each selected lookup returns one row and reads at most 12 shared blocks. The
lineage probe uses `grant_lineage_upstream`, the invitation probe uses its
primary key, the policy probe uses an ID-leading unique index and the proposal
probe uses an ID-leading unique index. The Agent-control fixture probes the
subject-indexed controller lookup
against 16,000 unrelated controller rows at a 17-row limit and 12-block bound.
These checks bound the exact-key phase;
the owner guards separately cap controller count, approvals, group impact,
roster size, role rebinds and topology walk. Each API fixture also copies the
isolated Access database after the write and checks retained effect/denial
state from that copy.
