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
`receipt-family.ts`. Internal model generation emits an event that needs a relay
contract for an operation without Access admission. Access admission owns the
current `semantic:read:<resource>` decision through `access/semantic-disclosure.ts`.
A committed active current head without protection, a restriction policy or a
strong-closed read gate is public when its `rv:semanticWork` link names at least
one currently public Work. The link is an IRI property of the semantic resource
profile and is written by the same admitted semantic create/edit command as
other properties. It cannot be established by a container mount or Statement.
Staging, unlinked resources and resources linked only to unpublished Works stay
private. Anonymous readers use the same Access decision. Older exact revisions
still require current read authority; public disclosure covers only the head.
An explicit read grantee can read a restricted resource. Its semantic edit
grantee can publish the existing Access policy on that resource's read scope.

The batch decision costs one bounded Jena query and one indexed policy/gate
lookup for at most 65 identities; a signed-in batch adds one indexed grant
query. Public and granted identities remain separate through summary hydration,
preview and media delivery. Work-derived graph fields require both the Work
owner branch and a bound Work variable: an unbound `EXISTS` would match an
unrelated publication ([SPARQL 1.1 EXISTS](https://www.w3.org/TR/sparql11-query/#func-filter-exists)).

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

`finite-rule.ts` admits one range-restricted positive conjunctive rule per
immutable rule revision. Body predicates are declared, the output is restricted
to `https://rezics.com/derived/`, and no identity or owner-authority output is
executable. The model generation keeps `NoEntailment` for automatic RDF/OWL
inference; the explicit rule closure checks that exact generation and refuses
identity-producing input. A partial closure has no exact count or authority.
The cost contract caps 16 selected rules, 10,000 facts, four body atoms, eight
rounds, 2,048 inferences and 50,000 pair inspections. To add a new rule form,
extend the checked profile and closure in this file, its graph profile in
`model/definitions/semantic-rule-v1.ts`, and the Context rule API tests; do not
interpret prose or arbitrary RDF as executable rules.
