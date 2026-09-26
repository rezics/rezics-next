# Semantic change operation

`admitted.ts` owns Account and Access admission, reference disclosure checks and
terminal receipt resolution. `change.ts` owns canonical state, guarded current
projection updates and immutable revision manifests. `command.ts` composes the
single Fuseki command, validation bindings, receipt, position and outbox event.
`read.ts` resolves current and exact revisions from their retained manifests;
`value.ts` implements exact value encodings and JSON-LD export. Routes live in
`src/routes/semantic.ts`; the owner shapes live in `model/definitions/semantic-*`
and `model/definitions/value-exact-v1.ts`.

Committed semantic and relation changes have distinct owner-declared outbox
events in `outbox-event.ts`, each bound to its Access admission, receipt and
exact revision. Their deterministic receipt families live in each owner's
`receipt-family.ts`. Internal model generation records a zero-event outbox batch
so the relay advances its sequence without fabricating Access authority. The Access owner also
needs a semantic Resource read grant check; until then current and exact reads
of semantic Resources and relation occurrences remain unavailable.

To extend a semantic operation, copy the admission, digest, expected-head guard,
poststate validation, terminal receipt resolution and exact-manifest read from
these files. Add an integration test with denial, same-key replay, changed intent,
stale head and missing history. Do not infer authority from a semantic type.

Cost contract: a synchronous change admits at most 32 types, 256 assertions,
64 new structured value nodes and 262,144 request bytes. It performs a bounded
number of owner/receipt/head lookups and one guarded Fuseki command; command
triples and validation focuses grow with the admitted state size, never with
the number of other Resources. Exact reads use one revision anchor and one
immutable manifest. Current reads also check the owned current projection.
The route's reference availability work grows with the number of distinct
resource references in the bounded state. Integration tests inspect the native
graph terms and retained history; engine work and recovery remain separate QA
evidence.
