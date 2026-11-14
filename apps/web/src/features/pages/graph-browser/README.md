# Subject graph public navigation

Decision: `public-address.ts` owns the pure public graph intent parser, address budget and shared Subject path
vocabulary. It imports only the literal candidate Context. The public `public-visit.ts` entry re-exports that
vocabulary and composes canonical Subject links; the broader Subject return parser consumes the pure leaf directly.
The leaf never imports either consumer. No dependency grant or cycle exception is needed.

Graph origin and Global return addresses retain their existing encoding, selectors, fallback and 2,048-character
and byte limits. A graph return names only its immediate Subject heading with its matching locale, Context and
optional Realm. Heading admission shares the Subject path grammar, including encoded-path rejection and the
existing Context/Realm casing rules. It never admits nested return navigation, evidence or credentials.

The existing [public-origin witness](../../../../tests/graph-public-origin.test.tsx) pins origin/Global handoffs and
return admission; [navigation witnesses](../../../../tests/subject-graph-browser-navigation.test.tsx) retain
Back/Forward, selected node/edge and correction return assertions. Existing
[graph stories](../../../stories/subject-graph-browser.stories.tsx) cover `MeaningfulRelations`,
`LongMultilingualLabels`, `ExactEdgeInspection`, `SparseExpansion`, `PendingSelection`, `FailureRecovery` and
`ReturnedSelection`. Pure address extraction needs no additional story states.
