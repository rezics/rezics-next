# API, SDK and MCP direction

Domain operations are shared capabilities for the web, SDK, CLI and MCP. They
expose resources and commands rather than tables or arbitrary graph writes.
Aggregate reads can reduce round trips only while preserving partial results
and execution budgets. The first-party web uses Main's exported app type through
a type-only Eden import; browser code does not import service implementation.

## Installed HTTP contract

The authored route schemas and [generated Main OpenAPI](../../generated/openapi/main/public.json)
define installed paths, validation and status-specific envelopes. The
[API extension procedure](../implementation/api-and-events.md#add-an-operation)
explains how to add an owner operation. Runtime schemas remain authoritative at
the transport boundary. [Problem Details](../implementation/api-and-events.md#operation-representation-and-errors)
use stable safe codes; unknown or undisclosed resources share the appropriate
response rather than disclosing hidden existence. Exact Content revision reads
are covered by the route schema and owner tests, including current disclosure,
verified historical bytes and private uncached responses.

## Contracts still requiring profiles and tests

- Preserve omitted, null and empty values separately, plus exact numeric strings,
  language, units, typed references and selection context in new profiles.
  Qualify generated clients for lossless numbers, discriminated unions and
  unknown or unsupported outcomes.
- Typed Filter/Search queries must bind context, authority and budgets. Any
  developer graph query needs an admitted read-only profile; it must never
  expose Jena admin or write access.
- Continuation cursors need a stable query, policy, context, generation and
  disclosure domain with deterministic tie breakers. A reusable snapshot across
  Fuseki HTTP requests is not assumed. A page and its generation check must
  share a read snapshot, or use a bounded materialized result; otherwise return
  restart-required. Counts and facets state their own exactness and population.
- Streaming and asynchronous operations require explicit deadline, cancellation,
  reconnect and per-item versus whole-batch atomicity contracts. HTTP acceptance
  alone does not establish successful publication or installation.
- External client and MCP adapters must preserve owner authority and operation
  semantics. MCP input, retrieved text and package text are data, not authority
  to use secrets or perform unrelated actions. [Connected apps](connected-apps.md)
  owns delegated ceilings.
