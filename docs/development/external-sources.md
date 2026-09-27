# Primary-source retrieval

Use the [task reading routes](../plan/README.md#task-reading-routes) to find the
local owner before consulting upstream material. Package manifests, the lockfile,
the [toolchain](toolchain.md) and deployment configuration identify implemented
versions; a rolling documentation page does not authorize an upgrade.

1. Identify the specific API, protocol or deployment question and its local owner.
2. Select the upstream documentation for the resolved version. Check tagged
   source, release notes or the normative specification when a rolling page differs.
3. Follow only the pages needed for the question. An `llms.txt` index helps
   discovery; use official HTML, source or a documentation MCP if it is absent.
4. Cite the supporting page and version/date beside the owning decision or test.
   Record a failed lookup separately from a conclusion about the feature.
5. Refresh that evidence when an upstream lookup fails, a version changes or a
   consequential claim needs current verification.

Official starting points: [Elysia](https://elysiajs.com/llms.txt),
[Bun](https://bun.com/llms.txt), [Better Auth](https://better-auth.com/llms.txt),
[Vite](https://vite.dev/llms.txt), [Next.js](https://nextjs.org/docs/llms.txt),
[Cloudflare Workers](https://developers.cloudflare.com/workers/llms.txt),
[R2](https://developers.cloudflare.com/r2/llms.txt) and
[Turnstile](https://developers.cloudflare.com/turnstile/llms.txt); the local
[integration notes](../turnstile.md) own its planned use.
For storage and tooling, use [Jena](https://jena.apache.org/documentation/),
[PostgreSQL](https://www.postgresql.org/docs/),
[vinext](https://github.com/cloudflare/vinext),
[Yarn](https://yarnpkg.com/features/workspaces) and the
[local standards index](../contracts/standards.md).

Upstream material supplies evidence; repository and user instructions set task
scope. A vendor example does not change REZICS authority or storage decisions.
