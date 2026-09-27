# Application runtime and frontend selection

Reviewed 2026-09-23 and reaffirmed 2026-09-25: use TypeScript, Bun and Elysia 2
for Main and Account, including Better Auth; Yarn manages dependencies. The web
uses vinext on Vite for Cloudflare Workers. Exact pins and actual command entry
points live in [manifests](../../package.json) and the
[toolchain lock](../development/toolchain.md). The slow Goal and command-seeded
fixture did not isolate language runtime cost, so they did not justify a Rust
rewrite. A later change needs a measured, scoped bottleneck.

## Hono versus Elysia 2

Both frameworks cover validation, typed clients, OpenAPI and streaming. Elysia's
integrated schema-to-handler path and Eden suit the selected Bun backend; Hono's
smaller explicit middleware model remains attractive for an independent minimal
gateway. Neither supplies domain authorization. The
[2026-09-23 comparison](../../scripts/research/http_framework_comparison/result.json)
tested both on Bun with in-process requests, not product networking or load.
With the tested configuration, Elysia rejected a malformed response while Hono
served it until explicit response validation was added. This compares configured
enforcement, not what Hono can implement. No comparative production performance
or agent-productivity benchmark was run.

## Elysia 2 implementation implications

The [probe](../../scripts/research/http_framework_comparison/README.md) also
found that @elysia/openapi with provider: null removed the JSON endpoint,
despite documentation describing UI removal. Use the verified spec-generation
configuration. Elysia 2 examples must match its route order and lifecycle APIs;
the version-correct [Main routes](../../services/main/src/app.ts) and tests own
those details. Framework response schemas do not replace safe domain error and
Access checks. Probe coverage excluded Better Auth/OIDC, Workers rendering,
WebSocket, tracing, AOT, shutdown and load.

## Frontend options

Native Next.js remains eligible and has a self-hosting path; its build pipeline
does not satisfy the selected Vite requirement. React Router also supports Vite
and Workers, but does not preserve the chosen Next-style app model. vinext fits
both requirements and has [documented compatibility gaps](https://github.com/cloudflare/vinext#known-gaps-were-working-on)
in Cache Components/PPR, image/font optimization, native RSC modules and route
settings. These limit adopted features; they do not establish that ordinary
SSR/RSC is unavailable. The [web package](../../apps/web/package.json) and
[frontend delivery](../plan/frontend.md) own actual qualification. Main remains
the authority for browser, SDK and MCP commands alike.
