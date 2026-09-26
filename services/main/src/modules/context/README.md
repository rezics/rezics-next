# Context operation template

`graph.ts` builds Context and public Realm-selection mutations. `command.ts` registers
the existing Access admission, writes a guarded graph update, and resolves the
durable operation receipt after an ambiguous response. `read.ts` reads an exact
revision through its immutable manifest. `interpretation.ts` resolves a bounded,
pinned selection chain; `private-selection.ts` keeps personal pointers in Access.
The route adapter is `../../routes/contexts.ts` and the real write/read template
is `tests/qa/integration/context-template.test.ts`.

For another graph-owned Context operation, copy the request digest, expected-head
guard, profile validation, receipt lookup, terminal outcome, and exact read path
from `graph.ts` and `command.ts`. Keep private selection links in Access and
reuse the current admission, graph receipt, revision anchor, object manifest,
outbox batch, and data-epoch fences. Add a bounded cost contract and a real
denied/stale/retry/recovery test with the operation.

Public Realm Context selections use `rv:contextSelectionHead` with an exact
expected-head graph guard. The existing Fuseki `rv:selectionHead` validator is
specific to publication receipts and scopes; Context selections must not use
that predicate until the validator admits their owner family.

`POST /v1/contexts/{id}/state-transitions` uses the same semantic-head CAS and
`context.state` receipt family. It copies the bounded sealed semantic manifest
into a new exact revision while changing only the Context's active/retired state.
Existing Statements and selections stay pinned; new selection of a retired
Context and new explicit Statement adoption are denied. The transition reads one
head and one manifest and never scans consumers.
