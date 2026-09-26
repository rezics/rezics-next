# Connected-app MCP boundary

Main stores bounded, immutable MCP observations in Content and binds explicit
tool ceilings to the current Account consent ID and generation. The access token
is forwarded only when its Account-verified audience exactly names the selected
MCP resource, and only to an endpoint on that resource's origin. The Account
assertion verifier requires live introspection before exposing consent claims.
Trusted and workload assertions cannot create a consent ceiling.

The client pins the stateless [MCP `2026-07-28` protocol](https://modelcontextprotocol.io/specification/2026-07-28)
and follows its [HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
and [tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
contracts. Every request carries the protocol version and client capabilities in
`_meta`, plus `MCP-Protocol-Version` and `Mcp-Method`; `tools/call` also uses
`Mcp-Name`. The client does not negotiate down to a legacy stateful version.
Server identity is informational and participates in observed drift; it does not
grant authority.

## Operations and bounds

| Operation | Work and byte limits | External effects |
| --- | --- | --- |
| `POST /v1/connected-apps/observations` | At most 64 pages, 1 MiB per page, 64 MiB total retained pages, 1,024 tools, and 256 KiB per tool definition. The exact pages, cursor chain, schema digests and server metadata are retained. | One `server/discover` and one `tools/list` request per page; each HTTP exchange has a 3 second deadline. Production transport requires HTTPS, rejects special/private DNS answers, pins the validated address and never follows redirects. |
| `POST /v1/connected-apps/consent-ceilings` | At most 1,024 selected tools. Only the fully validated JSON Schema subset is consentable; unimplemented keywords cannot pass through as an allow. | Fixed indexed owner reads plus O(k) ceiling-tool inserts for k selected tools. No outbound request. |
| `POST /v1/connected-apps/invocations` | At most 256 KiB of canonical JSON arguments; schema traversal is bounded to depth 32; MCP response is at most 1 MiB. | One fresh bounded observation, one `tools/call`, and at most one cancellation by closing the active response stream. Account introspection and Access principal lookup happen before dispatch. |
| `GET /v1/connected-apps/invocations/{invocation}` | One UUID and one principal-scoped indexed read. | No external request. |

The observation digest stored in the existing `tools_sha256` database slot is a
composite over the pinned protocol version, server metadata, server capabilities
and sorted tool definitions. This lets the existing immutable observation chain
invalidate a ceiling on any relevant drift without taking an unassigned
migration. Per-tool digests remain RFC 8785 canonical digests of the exact tool
definitions.

## Recovery and cost checks

Each invocation has a unique principal/idempotency key and an atomic `admitted`
to `sent` transition before the one external call. A retry never dispatches a
second call. Explicit JSON-RPC errors and tool-level `isError` results remain
distinct; cancellation, transport loss and malformed post-dispatch replies are
retained as uncertain. The existing schema stores a result digest, not the full
tool result, so only the first HTTP response carries the result payload. A replay
or receipt read returns the durable state and digest with `result: null`.

`tests/qa/integration/connected-app-api.test.ts` records the local peer's actual
discover/list/call counts, retained page count, forwarded authorization and
cancelled stream. It verifies the 64-page/1 MiB/1,024-tool/256 KiB guards in
source, while the integration cases exercise pagination, schema and capability
drift, denied scopes, exact audience forwarding, protocol/tool errors,
cancellation and no-redispatch recovery. These are operation work counters and
boundary checks; they do not claim a machine-independent latency result or
instrument PostgreSQL internals.
