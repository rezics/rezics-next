# API, SDK and MCP contracts

## Shared capability interface

Expose domain resources and commands rather than tables or arbitrary graph writes.
Web/BFF, SDK, CLI and MCP invoke the same operation and authority contracts.
Internal operations need not be public endpoints. Aggregate reads reduce client
round trips while preserving partial/unavailable results and execution budgets.

Each operation defines actor/authority context, inputs, preconditions, state
transition, atomicity, idempotency, output, failure states and observability.
Use OpenAPI for HTTP contracts and generated TypeScript clients. Qualify Rust
`aide`/`schemars` against the chosen OpenAPI profile before fixing the generator;
schemas do not replace runtime validation.

[API and event surfaces](../implementation/api-and-events.md) defines command
families, common operation status and versioned transport envelopes.

## Wire semantics

Preserve omitted/null/empty, exact numbers, language, units, typed references and
selection context. Serialize large integers/decimals losslessly. Errors have a
stable code, safe message, request/operation ID and typed details. Distinguish
unauthenticated, denied, not found under disclosure policy, stale revision,
unsupported profile, partial source, budget exhaustion and dependency unavailable.

Commands use expected revisions and idempotency keys. Asynchronous commands
return an operation resource with progress, cancellation and terminal outcome;
HTTP acceptance is not successful publication or installation. Bulk operations
declare per-item versus whole-batch atomicity and report every item.

## Queries and pagination

Ordinary clients submit typed Filter/Search descriptors. Trusted compilation
binds datasets, context, authority and resource limits. Developer graph queries
use an admitted read-only profile with the same budgets and disclosure checks;
there is no unrestricted public Fluree admin/write surface.

Cursors bind query/policy revisions, ordering, context, generation and disclosure
domain. Use deterministic tie breakers and keyset or engine snapshot continuation.
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
