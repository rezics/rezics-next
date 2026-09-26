# Saved graph layout template

`store.ts` handles the real write/read pair in `routes/graph-layouts.ts`:
`POST /v1/graph-layouts` saves an exact Content draft revision and
`GET /v1/graph-layouts/:layoutId` reads its current or named revision. Copy
`schema.ts`, `store.ts`, the route module and
`tests/qa/integration/graph-layout-api.test.ts` for another Content-owned view
artifact. Keep Content's draft receipt, head CAS, immutable revision and outbox;
the `content.graph_layout` row only binds a layout to its owner and view identity.

The write request names the acting Agent, optional layout and expected head,
and a bounded body of positions and display groups. The response names the
layout, revision, predecessor, digest and replay status. The read response
returns the same exact body. Access grants gate both paths; a foreign layout
is unavailable to the caller. A lost response replays the Content receipt.

Cost contract: each save performs a fixed number of Access and Content
statements for a body of at most 2,000 nodes and 200 groups. Each exact read
uses one binding lookup and one bounded Content revision read. The integration
fixture compares statement counts for one and 200 positions and snapshots all
graph triples around a display-group move.
