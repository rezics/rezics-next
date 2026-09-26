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
