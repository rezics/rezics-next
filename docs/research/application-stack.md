# Application runtime and frontend selection

Reviewed 2026-09-23 against official documentation, npm package metadata and the
old repository's manifests/configuration. The maintainer selects **TypeScript,
Elysia 2.0 and Bun for the production backend; Yarn workspaces for dependency
management; Cloudflare Workers and Vite for the frontend**. vinext is the frontend
recommendation for those requirements. This replaces Rust Main and the earlier
React Router preference, without changing Jena, PostgreSQL or domain ownership.

Reaffirmed by the maintainer on 2026-09-25: retain this stack, including Better
Auth. Correct the [delivery strategy](../plan/execution-workflow.md),
[cost verification](../testing/complexity.md) and data preparation first. The slow
Goal and multi-hour command seeding do not isolate TypeScript runtime cost, so
they do not justify a Rust rewrite. This decision does not claim TS and Rust have
equal throughput; a later language change needs a measured, scoped bottleneck.

Owners: [architecture](../architecture/overview.md), [Main](../services/main.md),
[Account](../services/account.md), [workspace layout](../development/repository-structure.md)
and [frontend delivery](../plan/frontend.md). These are target choices; the product
services are not implemented or deployed by this research task.

## Version evidence

| Package/runtime | Observed release | Selection and limit |
| --- | --- | --- |
| Elysia | `next`: `2.0.0-beta.16`, published 2026-09-18; `latest`: `1.4.30` | Select the 2.0 line as requested; pin the exact beta instead of floating `next` or accidentally installing 1.x. |
| Bun | `1.4.2`, published 2026-09-05 | Backend runtime for both local development and production. |
| Yarn | `@yarnpkg/cli-dist@4.18.0` | Workspace/package manager; use `nodeLinker: node-modules` and immutable installs. |
| Elysia plugins | OpenAPI `2.0.0-beta.4`; CORS and OpenTelemetry `2.0.0-beta.1`; Eden `2.0.0-beta.5` | Observed 2.0-compatible peer ranges; peer metadata is not runtime integration evidence. |
| Hono | `4.13.8` | Comparison candidate; not selected as a second Main framework. |
| vinext | `1.0.0-beta.11`; `@vinext/cloudflare@1.0.0-beta.9` | Matching declared peer range for Vite/Workers; the product build remains unqualified. |
| Next.js | `16.3.6` | Native Next alternative; do not infer complete parity from vinext's Next 16 API target. |

Sources: [Elysia registry](https://registry.npmjs.org/elysia),
[plugin metadata](https://registry.npmjs.org/@elysia%2Fopenapi),
[Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2),
[Yarn registry](https://registry.npmjs.org/@yarnpkg%2Fcli-dist),
[Hono registry](https://registry.npmjs.org/hono),
[vinext registry](https://registry.npmjs.org/vinext),
[Cloudflare adapter metadata](https://registry.npmjs.org/@vinext%2Fcloudflare),
[Next registry](https://registry.npmjs.org/next).
Recheck release metadata when creating a production lockfile; the table is a
dated selection baseline, not an automatic update policy or a prediction of
unreleased year-end versions.

## Hono versus Elysia 2

| Concern | Elysia 2 on Bun | Hono | REZICS consequence |
| --- | --- | --- | --- |
| HTTP and data validation | Declarative request/response schemas and inferred handler types; TypeBox and Standard Schema support. | Small HTTP core with validator middleware and schema integrations. | Both cover the API. Elysia reduces the number of choices for the normal schema-to-handler path. |
| OpenAPI and typed clients | Official versioned OpenAPI plugin and Eden; public SDKs can still consume OpenAPI. | `@hono/zod-openapi` or `hono-openapi`; `hc` RPC client. | Both qualify. Schema documentation/type inference alone must not be mistaken for runtime response validation. |
| Errors and hooks | Elysia 2 has Problem Details, typed error handlers, scoped plugins/macros and lifecycle hooks. | Explicit middleware chain, context and error handler. | Hono's smaller execution model may ease debugging; Elysia provides more integrated conventions. Neither implements domain authorization. |
| Streaming and WebSocket | Fetch responses and streaming; 2.0 WebSocket is opt-in and Bun-aware. | Streaming/SSE helpers and runtime-specific WebSocket helpers. | No demonstrated required feature gap. Cancellation, reconnect and authorization still need tests. |
| Authentication, CORS and tracing | Fetch handler integration and compatible official plugins. | Fetch handler integration, built-in CORS and middleware integrations. | Better Auth can serve either; no reason to rewrite Account merely for Hono. |
| Edge and runtime reach | Web APIs, adapters and optional AOT build; Bun is the selected host. | Small dependency-free core with runtime adapters. | Hono is attractive for a small independent multi-runtime/edge gateway. That is not a current requirement for Main. |
| Build/runtime mechanisms | Compiler/AOT and schema machinery provide optimization but add behavior to understand. | Less framework machinery; explicit middleware assembly. | Measure actual debugging/feedback cost, not just dependency count. |

Primary sources: [Elysia validation](https://elysiajs.com/essential/validation),
[Elysia OpenAPI](https://elysiajs.com/plugins/openapi),
[Hono validation](https://hono.dev/docs/guides/validation),
[Hono OpenAPI](https://hono.dev/examples/hono-openapi),
[Hono middleware](https://hono.dev/docs/concepts/middleware),
[Hono streaming](https://hono.dev/docs/helpers/streaming),
[Hono WebSocket](https://hono.dev/docs/helpers/websocket),
[Better Auth/Elysia](https://better-auth.com/docs/integrations/elysia),
[Better Auth/Hono](https://better-auth.com/docs/integrations/hono), and
[Elysia tracing](https://elysiajs.com/plugins/opentelemetry).
Some unversioned Elysia documentation still shows 1.x syntax. The
[2.0 release/migration notes](https://elysiajs.com/blog/elysia-20) and pinned
package declarations take precedence for 2.0 code.

The functional review found no required capability that justifies replacing
Elysia 2 with Hono in this Bun-hosted backend. Hono would merit reconsideration
for an independently deployed minimal gateway, a proven runtime-adapter problem,
or a representative task showing materially lower integration/debugging cost.
No comparative production performance or AI productivity benchmark was executed.
Framework-author microbenchmarks do not establish REZICS throughput or memory use.

For AI-assisted development, the expected benefit of TypeScript across the web,
Main and Account is fewer language/toolchain transitions when changing contracts.
Elysia's integrated schema-to-handler path can further reduce repeated wiring;
Hono's explicit middleware may instead make unfamiliar control flow easier to
inspect. These are engineering expectations, not measured agent productivity.
Keep ordinary domain code simple and version-correct examples executable. Retain
Rust where a real native solver or worker supplies a demonstrated capability.

### Elysia 2 implementation implications

Use the 2.0 route order `(path, options, handler)` and updated lifecycle/error
APIs. TypeBox moved to its 1.x package. WebSocket registration is opt-in. Do not
mix copied 1.x examples with 2.0 plugins. Keep a small canonical route example
beside the implemented service so agents have local, version-correct guidance.

Explicit schemas remain the source for validation/OpenAPI. TypeScript 7's
compiler API transition needs separate qualification for any type-extraction
generator ([TypeScript release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
Do not make type extraction a prerequisite for the first route. Keep domain error
codes and safe details stable through framework Problem Details translation.

AOT is an optional optimization. Its route capture can execute application setup;
keep application construction separate from database connections, listeners and
workers. Response callbacks are not durable jobs. These are implementation
consequences, not reasons to reject the selected framework.

## Frontend options

Native Next.js is eligible: it supports self-hosted servers/containers and
requires explicit cache coordination when deployed across instances
([official deployment guide](https://nextjs.org/docs/app/guides/self-hosting)).
The earlier blanket rejection for platform lock-in was not supported. Next's
integrated App Router/RSC/cache model can be useful for this content product.

The selected requirements are **Cloudflare Workers and Vite development**.
vinext reimplements the Next API on Vite and supplies Workers integration, so it
fits both while preserving a Next-style application model. Cloudflare's
[current Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
explicitly recommends vinext as the default Workers deployment path. Native Next
uses its own build path; OpenNext remains an alternative for compatibility needs,
but does not replace Next's build with Vite. A Storybook Vite integration does not
change that. React Router
Framework Mode also fits Workers/Vite, but its presence
alone is not a reason to replace the preferred Next-compatible model.

The [upstream vinext README](https://github.com/cloudflare/vinext#known-gaps-were-working-on)
documents concrete limitations: incomplete Cache Components/PPR behavior,
different image/font optimization, native-module issues in RSC development, and
ignored `runtime`/`preferredRegion` route settings. Its Vite pipeline also does not
consume Turbopack/webpack configuration. These constrain adopted features; they
are not evidence that ordinary SSR/RSC, actions or metadata are unavailable.

On this deployment, keep media transforms in an admitted backend/platform adapter,
keep private rendering scoped to each authenticated request, and qualify public
cache invalidation and locale/authority variation before enabling shared caching.
Use Server Actions only as web adapters to Main commands. Main owns authorization,
receipts and domain effects for browser, SDK and MCP alike.

The old repository was inspected: `apps/web/package.json` runs vinext, its Vite
configuration composes Cloudflare/RSC/PWA, and its UI package uses SharkUI/Ark UI.
It contains Storybook alpha dependencies and patches. Reuse useful patterns and
components while choosing a fresh coherent dependency set; neither full-copy
reuse nor a framework replacement is required by the redesign.

## Workspace and qualification

Yarn installs dependencies and selects workspace commands; those commands invoke
Bun explicitly for the backend. Use one Yarn lockfile for application packages,
without a parallel Bun install/lockfile. A supported Node runtime may execute
Yarn and frontend tooling; the production web runtime is Workers' workerd, while
the production Main/Account runtime is Bun. See
[Yarn workspaces](https://yarnpkg.com/features/workspaces) and
[nodeLinker](https://yarnpkg.com/configuration/yarnrc#nodeLinker).

The [reproducible probe](../../scripts/research/http_framework_comparison/README.md)
ran on Bun 1.4.2 through a Yarn 4.18 workspace on 2026-09-23. TypeScript 7 checking
of fixture API usage and the behavioral assertions passed. The
[recorded result](../../scripts/research/http_framework_comparison/result.json)
shows valid/invalid requests, lossless integer strings, rejected admission before
handler effects, two forwarded cookies, CORS, request/response OpenAPI schemas
and finite event-stream output working in both configured frameworks.

Two differences matter for implementation:

- Elysia rejected a deliberately malformed response against its explicit schema
  with HTTP 500; Hono plus `@hono/zod-openapi` served it with HTTP 200 until an
  explicit response validator was added. This is a difference in configured
  enforcement, not an inability to implement validation in Hono.
- `@elysia/openapi@2.0.0-beta.4` with `provider: null` returned 404 for the JSON
  endpoint as well as disabling the UI. Its installed source returns before
  registering either route, despite the README describing the option as disabling
  the frontend. The default configuration exported OpenAPI 3.1.2 successfully.
  Use the working configuration in a private spec-generation context and publish
  the resulting artifact; do not assume `provider: null` preserves `/openapi/json`.

The probe uses in-process Request/Response calls, not a network listener. It does
not start product services or qualify database, Better Auth/OIDC, production
networking, Workers rendering, WebSocket, tracing, AOT, streaming cancellation,
shutdown or load behavior. Those remain owning integration checks. TypeScript
used `skipLibCheck`, so upstream declarations were not audited in full.
