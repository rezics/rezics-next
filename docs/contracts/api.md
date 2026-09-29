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

## Executable capability registry

Decision 14, product manager under maintainer delegation, 2026-09-29.
Each supported capability is to declare authority, inputs, outcomes, pagination,
retry/recovery, SDK/MCP mapping and the human journey: discover, act, confirm,
return, recover, leave. Internal and deferred capabilities retain a reason.
The registry generates the developer portal and fails checks on undeclared gaps.
This is a target beyond installed OpenAPI, not a second prose endpoint inventory.

The reason is that a callable route alone says neither how to complete a task
nor how to recover it. [OpenAPI](https://spec.openapis.org/oas/latest.html)
describes transport, while [GitHub's MCP toolsets](https://github.com/github/github-mcp-server)
illustrate task-oriented discovery. REZICS adds explicit journey coverage rather
than exposing one undifferentiated tool per endpoint.

## Developers and phones

Decision 25, product manager under maintainer delegation, 2026-09-29.
Deliver the registry-generated portal, an external TypeScript SDK, scoped
personal/delegated credentials, [RFC 9457 errors](https://www.rfc-editor.org/rfc/rfc9457.html)
and durable event replay. Responsive web is the first mobile client, with optional
PWA installation, web push, durable cross-device progress and rights-aware offline
downloads. Correctness never depends on background execution.

The reason is one complete API experience across interactive and unattended
clients. [Service-worker lifecycle constraints](https://www.w3.org/TR/service-workers/#service-worker-lifetime)
motivate resumable foreground recovery; installation is not a promise that the
OS will keep work running. [Synchronization](client-synchronization.md) owns
pending writes, cache custody and revocation limits.
