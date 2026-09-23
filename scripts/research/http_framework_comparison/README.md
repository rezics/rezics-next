# Bounded HTTP framework comparison

This isolated research workspace compares Elysia 2/Bun with Hono on the same Bun
runtime. It is not the product workspace or a throughput/AI productivity benchmark.
Its owner is the [application stack review](../../../docs/research/application-stack.md).
Executed on 2026-09-23; the fixture's TypeScript check and behavioral assertions passed.

Use Bun 1.4.2 and Yarn 4.18.0. From this directory:

```sh
corepack yarn install --immutable
corepack yarn workspace @rezics-research/framework-probe run typecheck
corepack yarn workspace @rezics-research/framework-probe run probe
```

The root is a Yarn workspace, with a conventional `node_modules` linker; Yarn
executes the member's explicit `bun probe.ts` command. No network listener,
database or product server starts. Results print to stdout. The recorded
[result](result.json) belongs to the pinned lockfile and runtime.

The fixture verifies valid/invalid requests, a large integer represented as a
decimal string, a denied operation that must not execute its handler, two cookies
forwarded by a synthetic Fetch handler, CORS, schema-based OpenAPI, a finite SSE
response and malformed response handling. Hono's OpenAPI declaration is tested
separately from an explicit response validator. Deliberate casts in invalid
response fixtures are fault injection, not recommended application code.

In `@elysia/openapi@2.0.0-beta.4`, `provider: null` suppresses the JSON route as
well as the UI: `/openapi/json` returns 404. The fixture records this separately
from the working default configuration, which exports OpenAPI 3.1.2. Do not use
the headless setting expecting it to preserve that endpoint. Hono's declaration
alone allows the deliberately malformed response; adding explicit validation
rejects it. This compares configured behavior, not whether Hono can validate output.

`skipLibCheck` limits TypeScript checking to fixture usage of the package APIs;
this is not a full audit of upstream declarations. The synthetic Fetch handler is
not Better Auth: sessions/OIDC, permissions, streaming cancellation, sockets,
tracing, AOT, production networking, database semantics and load remain untested.
