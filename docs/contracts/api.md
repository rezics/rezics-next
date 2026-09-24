# API, SDK and MCP contracts

## Shared capability interface

Expose domain resources and commands rather than tables or arbitrary graph writes.
Web/BFF, SDK, CLI and MCP invoke the same operation and authority contracts.
Internal operations need not be public endpoints. Aggregate reads reduce client
round trips while preserving partial/unavailable results and execution budgets.

Each operation defines actor/authority context, inputs, preconditions, state
transition, atomicity, idempotency, output, failure states and observability.
Use OpenAPI as the published HTTP contract for external clients. Qualify Elysia
2's schema-based OpenAPI plugin against the chosen profile, including lossless
numbers, nullable/omitted fields, status-specific responses and Problem Details.
Keep executable schemas authoritative at the transport boundary; TypeScript-only
types and typed clients do not replace runtime validation. The first-party web
uses Eden over Main's exported app type through a type-only import. This does not
replace the published contract or permit browser imports of service code.

[API and event surfaces](../implementation/api-and-events.md) defines command
families, common operation status and versioned transport envelopes.

## Wire semantics

Preserve omitted/null/empty, exact numbers, language, units, typed references and
selection context. Serialize large integers/decimals losslessly. Errors have a
stable code, safe message, request/operation ID and typed details. Distinguish
unauthenticated, denied, not found under disclosure policy, stale revision,
unsupported profile, partial source, budget exhaustion and dependency unavailable.

Main's `GET /v1/content-revisions/{revision}?actingSubject={subject}` is an
exact retained Content read. The path names the Content revision UUID; it does
not select a variant head or public projection. The bearer token needs Account
`work:read`. Main resolves the revision's owning Work internally, checks the
current Access `work.read` grant at `work:read:{Work URI}` for the acting
subject, and requires that Work in the current graph. The 200 response carries
`reference` (including Content owner, resource/variant/revision IDs, format,
model, SHA-256 byte digest and length, language, direction, source revision and
provenance), the exact UTF-8 JSON serialization as `serializedJson`, and its
parsed object as `body`. Historical bytes are read and verified by Content.
Unknown, erased, or currently undisclosed revisions share a 404 response;
unavailable or corrupt committed bytes return 503 only after disclosure is
admitted. Responses are private and uncached. Malformed inputs return 400;
invalid Account assertions return 401; unavailable authorities return 503.

Commands use expected revisions and idempotency keys. Asynchronous commands
return an operation resource with progress, cancellation and terminal outcome;
HTTP acceptance is not successful publication or installation. Bulk operations
declare per-item versus whole-batch atomicity and report every item.

## Queries and pagination

Ordinary clients submit typed Filter/Search descriptors. Trusted compilation
binds datasets, context, authority and resource limits. Developer graph queries
use an admitted read-only profile with the same budgets and disclosure checks;
there is no unrestricted public Jena admin/write surface.

Cursors bind query/policy revisions, ordering, context, generation and disclosure
domain. Use deterministic tie breakers. Initial Fuseki queries have no reusable remote
transaction token: exact continuation uses a bounded materialized result, or a
generation check that returns restart-required after relevant changes. The
check and page data must share one SPARQL request, with fixed temporal inputs and
qualified index-reader pairing for text. When that cannot be guaranteed, use a
materialized result or require restart. Keyset ordering alone does not preserve
a snapshot.
Invalid/expired cursors return restartable outcomes. Counts and facets declare
their population and exact/estimated/partial status independently of page size.
Streaming responses preserve cancellation, deadlines and reconnect semantics.

## Events and protocol evolution

Version event envelopes and incompatible HTTP contracts explicitly. Generated
clients preserve discriminated unions and unknown/unsupported outcomes. Introduce
breaking target contracts directly in this redesign; do not add compatibility
layers for an obsolete runtime. Within a released new contract, support its
declared deprecation policy and update consumers together.

MCP tool descriptions mirror command consequences and scopes. Tool input,
retrieved documents and package text are data, never authority to use secrets or
execute unrelated actions. [Connected apps](connected-apps.md) owns delegation.
