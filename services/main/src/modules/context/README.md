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

`POST/GET /v1/contexts/{id}/preferences` copies the Context command template in
`preferences.ts`: a separate preference-head CAS, an immutable `context-v1`
preference revision, a sealed manifest, receipt and outbox. It caps labels at 256
and does not scan Context consumers. `GET /v1/contexts/{id}/skos` reads one exact
semantic and preference revision, then emits scoped SKOS concept IRIs; each
concept has at most one preferred label per language. Different Contexts can
choose different labels for the same target without publishing global labels or
changing Statement meaning.

`POST/GET /v1/context-definition-states` uses `definition-state.ts` and
`context-definition-state-v1`: one exact DefinitionRef lifecycle, guarded by its
own CAS head. Retirement rejects new Statement/Context use and adoption of
pinned dependencies while preserving historical exact references. The operation
reads one lifecycle head and never scans Statements or Context consumers.

`POST/GET /v1/context-definition-equivalences` reviews and reads one symmetric
mapping between two exact definition uses in the current semantic revision. Its
Access action is `context.equivalence.review`, guarded by the Context change
scope; its graph command checks both entries and retired-definition controls
without scanning Statements. `POST /v1/context-meaning-comparisons` reads two
exact Statements and at most one reviewed mapping. It returns equivalence only
when subject, relation, relation definition, applicability and pinned Context
basis agree; unqualified Red and EyeColor=Red remain distinct from HairColor=Red.
Mapping targets and Statement meaning keys retain their own identities.

The [W3C SKOS Reference](https://www.w3.org/TR/skos-reference/#S14) requires at
most one `skos:prefLabel` per language on one resource and distinguishes concept
mapping from `owl:sameAs` identity. The scoped concept IRI is our deduction for
Context-local preferred labels; the reviewed qualified-use mapping is narrower
than a blanket `skos:exactMatch` between target resources. The integration cases
exercise same-language counterexamples and check that no identity triple is
created. Human vocabulary review remains outside this API test.

Relationless interpretation previews include at most 26 qualified candidates
from the bounded pinned chain. They return `ambiguous` with exact relation,
definition and entry revision when no generic entry settles the target; overflow
returns `unavailable`. A Statement write always has an exact predicate and never
uses an ambiguous preview as admission.
