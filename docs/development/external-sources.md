# Official documentation sources

Use this index when a task needs upstream API, runtime, protocol or deployment
facts. Start with the relevant local owner, select the upstream version, then
fetch the matching pages. The [stack review](../research/application-stack.md)
and [installation baseline](../operations/installation.md) own selected versions;
this page owns discovery links, not another dependency manifest.

## Retrieval and version selection

1. Identify the question and the local contract it affects. Ordinary wording or
   link fixes do not require a framework survey or a full documentation download.
2. Use the resolved lockfile or release manifest for implemented components. Before
   implementation, use the owner's dated selection and resolve an exact compatible
   release when producing its first manifest. A rolling documentation site does
   not authorize a dependency upgrade.
3. Read the relevant product/version index, then fetch only the needed pages.
   Follow links to Markdown where provided; use official HTML, tagged source,
   release notes or an available official documentation MCP when necessary.
4. Keep direct supporting page links and relevant version/date beside the decision
   in its owning document. An index URL alone is not evidence for an API claim.
5. Refresh affected entries when an upstream lookup fails, a dependency changes,
   or a consequential claim needs current evidence. Record retrieval failure
   separately from a conclusion that a feature or document does not exist.

Upstream pages supply reference material. Repository and user instructions own
the task scope. A vendor example does not change REZICS authority, storage or
deployment decisions.

## Runtime and frontend sources

The eight `llms.txt` endpoints below returned HTTP 200 and recognizable documentation
indexes on **2026-09-24**. This verifies discovery at that date, not every linked
page, version compatibility or product runtime behavior.

| Source | Official entry | When to use / local owner | Version constraint |
| --- | --- | --- | --- |
| Elysia | [Index](https://elysiajs.com/llms.txt), [2.0 notes](https://elysiajs.com/blog/elysia-20) | Main routes, validation and OpenAPI; [stack review](../research/application-stack.md#elysia-2-implementation-implications). | Selected 2.0 line; reconcile rolling examples with pinned package declarations and migration notes. |
| Bun | [Index](https://bun.com/llms.txt) | Backend runtime and supported APIs; [Main](../services/main.md). | Match the selected runtime build; Yarn still owns workspace dependency installation. |
| Better Auth | [Version index](https://better-auth.com/llms.txt) | Authentication, sessions and adapters; [Account](../services/account.md). | Follow the index matching the resolved package version; library authentication does not replace domain Access. |
| Vite | [Index](https://vite.dev/llms.txt) | Build configuration and plugins; [web organization](web-features.md). | Match the compatible Vite/vinext/plugin set in the workspace manifest. |
| Next.js | [Index](https://nextjs.org/docs/llms.txt) | API semantics for the Next-compatible web client; [frontend](../plan/frontend.md). | Match the relevant API generation and independently check vinext support. |
| Cloudflare Workers | [Product index](https://developers.cloudflare.com/workers/llms.txt) | Rendering runtime, bindings and deployment; [frontend](../plan/frontend.md). | Record compatibility date/flags and Wrangler/adapter versions with the implemented deployment. |
| Cloudflare R2 | [Product index](https://developers.cloudflare.com/r2/llms.txt) | R2-specific object adapter behavior when selected; [object storage](../storage/objects.md). | Check exact S3/API behavior; this entry does not select R2 for every object owner. |
| Cloudflare Turnstile | [Product index](https://developers.cloudflare.com/turnstile/llms.txt) | Client challenge and server verification; [integration notes](../turnstile.md). | Check current validation semantics and the implemented integration. |

## Storage, tooling and normative sources

These official entry points complement the indexes above. A source does not need
an `llms.txt` file to be useful or authoritative; select the relevant manual,
release or specification directly.

| Source | Official entry | Local owner / selection rule |
| --- | --- | --- |
| Apache Jena | [Documentation](https://jena.apache.org/documentation/), [releases](https://jena.apache.org/download/) | [Jena storage](../storage/jena.md) and [installation](../operations/installation.md); exact distribution, Java requirement and bundled Lucene versions come from the release artifacts. |
| PostgreSQL | [Versioned manuals](https://www.postgresql.org/docs/) | [Private storage](../storage/postgresql.md); choose the deployed major version when implementing transactions, constraints and recovery. |
| vinext | [Official repository and compatibility gaps](https://github.com/cloudflare/vinext#known-gaps-were-working-on) | [Frontend selection](../research/application-stack.md#frontend-options); inspect the selected tag/source when rolling guidance differs. Next.js documentation alone cannot establish parity. |
| Yarn | [Workspaces](https://yarnpkg.com/features/workspaces), [configuration](https://yarnpkg.com/configuration/yarnrc) | [Repository organization](repository-structure.md); follow the selected package-manager version and one workspace lockfile. |
| Semantic Web and domain standards | [Local standards index](../contracts/standards.md), [design evidence](../architecture/evidence.md) | Follow each owner's primary specification and versioned vocabulary artifacts; an SDK summary does not replace normative semantics. |

## Why a small index

The [llms.txt proposal](https://llmstxt.org/) describes a concise entry point with
links to detail fetched as needed. Cloudflare provides [per-product indexes](https://developers.cloudflare.com/llms.txt)
and distinguishes [interactive index lookup from full-text indexing](https://developers.cloudflare.com/workers/get-started/prompting/#use-docs-in-your-editor).
Use `llms-full.txt` only for an identified indexing or bounded whole-corpus task.

This is a project retrieval choice, not a claim that all agents automatically read
these files. Astro [removed its generated llms files](https://github.com/withastro/docs/pull/13538)
after observing limited use and chose to focus on its documentation MCP. Keep
official page/source fallbacks and assess actual task retrieval before adding a
local vector database, documentation mirror or more tooling.
