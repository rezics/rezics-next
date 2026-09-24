# Toolchain lock

This page is the adopted toolchain for the first delivery. Implementation uses
only the tools listed here, at these versions, through the root commands below.
Versions were checked on 2026-09-24 against the npm registry, Docker Hub, Maven
Central and upstream release pages. The [toolchain survey](../research/toolchain-survey.md)
and [stack review](../research/application-stack.md) remain research inputs; they
do not select tools.

## Rules

- **Exact pins.** `package.json` files use exact versions; Yarn installs with
  `--immutable`. Compose files and Dockerfiles reference images by tag and
  digest; record the digest in the same commit that first pulls an image.
- **One command facade.** Root `package.json` scripts are the only entry points
  agents and developers use. Nx, Turbo, Task/go-task and Aspire are not used.
- **Status values.** *Adopted*: use now. *Stage X*: adopt when that
  [dependency stage](../plan/README.md#dependency-order) starts, after rechecking
  the version. *Not used*: do not add.
- **Changing a row.** Edit this page in the same commit as the dependency
  change, with the reason and the check that passed. A tool that is absent from
  this page is not available to an implementation batch.
- **Qualification gates.** Rows marked *gate* are proven in Phase 0 of the
  [execution program](../plan/README.md#execution-program) within one batch. If a
  gate fails, apply its documented fallback and update this page; do not start
  open-ended research during implementation batches.

## Root commands

| Command | Effect |
| --- | --- |
| `yarn toolchain:install` | Checks Docker, Bun and Node; pulls pinned images; builds the Fuseki image; installs the Playwright Chromium build. Idempotent. |
| `yarn stack:up [--profile dev\|qa]` | Starts the Compose project for local services and prints generated endpoints. `stack:down` and `stack:reset` stop it or remove its volumes. |
| `yarn dev` | Runs `stack:up`, then Main, Account and web in watch mode on the host. |
| `yarn gen` | Runs the model compiler and exports OpenAPI; `yarn gen:check` fails on drift. |
| `yarn check` | Typecheck of every workspace, Biome, dependency-cruiser and `gen:check`; target under 2 minutes. |
| `yarn test <paths> [-t <ID>]` | Runs targeted tests against the QA stack. |
| `yarn qa` | Runs the full [executable harness](../testing/test-harness.md) in at most 30 minutes; `--record` regenerates the [qualification page](../plan/qualification.md). |
| `yarn fixtures:pull` | Refreshes the remote fixture cache. |
| `yarn load` | Runs the k6 load profile by itself. |
| `yarn docs:check` | Runs the Python documentation checker and its regression tests. |

Dev and QA secrets are generated per Compose project into `.temp/stack/<project>/`
and never committed. SOPS/age apply at the deployment stage.

## Runtimes and languages

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| Bun | 1.4.2 | Adopted | Main, Account, harness scripts and backend tests (`bun test`). |
| Node.js | 26.8.2 (`.nvmrc`) | Adopted | Yarn, Vite/vinext, Storybook, Vitest, Playwright and wrangler. |
| Yarn | 4.18.0, `nodeLinker: node-modules` | Adopted | One lockfile for all workspaces. |
| TypeScript | 7.0.2 | Adopted | `tsc --noEmit` per workspace. |
| Java | Temurin 21 JRE in `eclipse-temurin:21.0.12_8-jre-noble` | Adopted | Fuseki runtime inside its image; no host Java required. |
| Maven | `maven:3.9.16-eclipse-temurin-21` build stage | Adopted | Builds the Fuseki command module inside the image build. |
| Python | 3.10+ standard library | Adopted, docs only | The [documentation checker](README.md). The Python model validators are retired by Phase 0. |

## Local services

Docker Compose runs third-party services and databases. Main, Account and the
web app run as host processes for fast reload in development and are started by
the harness for end-to-end and load tiers. They are not containerized in the
first delivery; production placement stays with [deployment](../operations/deployment.md).

The topology lives in `infra/dev/compose.yaml` (project `rezics-dev`, or
`rezics-qa-<run>` for the harness). Every published port binds to `127.0.0.1`.
Development uses named volumes; QA uses tmpfs except in the recovery tier.

| Service | Image | Status | Purpose |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:18.6-trixie` | Adopted | One cluster with separate databases and login roles for Account, Access and relay. `wal_level=replica` and WAL archiving to a volume support PITR drills. Init SQL lives in `infra/dev/postgres/`. |
| Fuseki | `rezics/fuseki:6.2.0-cmd<module-version>`, built locally | Adopted | TDB2 + jena-text with the REZICS command module and generated shapes; see below. |
| Object storage | `rustfs/rustfs:1.0.0` | Adopted, gate | S3 API for revision payloads, manifests and later media, replacing Main's filesystem object directory. |
| Fault proxy | `ghcr.io/shopify/toxiproxy:2.12.0` | Adopted (QA) | Latency, timeout, reset and lost-response faults between the apps and Fuseki/PostgreSQL, controlled through its HTTP API. |
| Mail sink | `axllent/mailpit:v1.31.2` | Adopted | SMTP sink for Account email; tests read messages through its HTTP API. |
| Load generator | `grafana/k6:2.3.0` | Adopted | Run with `docker run --rm --add-host=host.docker.internal:host-gateway`. |

The object storage gate proves conditional create (`If-None-Match: *`), checksum
verification, concurrent writers of one key and restore against RustFS through
Main's adapter, which uses Bun's built-in `S3Client`. If `S3Client` cannot send
conditional headers, the fallback is `aws4fetch` 1.0.20 signed `fetch`. Choosing
the production object backend remains under [object storage](../storage/objects.md).

### Fuseki image and command module

`infra/jena/Dockerfile` builds the image in two stages:

1. The Maven stage builds `infra/jena/command-module/`, a Java 21 project
   (`com.rezics:fuseki-command`). `jena-fuseki-main` 6.2.0 is a `provided`
   dependency, because the pinned `fuseki-server.jar` already contains jena-text
   and jena-shacl.
2. The runtime stage uses `eclipse-temurin:21.0.12_8-jre-noble`. It downloads
   `apache-jena-fuseki-6.2.0.tar.gz`, verifies SHA-512
   `ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132`
   and extracts it. It then copies the module jar into `$FUSEKI_BASE/extra/`
   (the pinned launcher appends `${FUSEKI_BASE}/extra/*` to the classpath), the
   generated shapes into `/fuseki/profiles/`, and the assembler.

The product assembler moves from `docs/operations/examples/fuseki-text.ttl` to
`infra/jena/fuseki-text.ttl` in Phase 0, and its references are updated. It
exposes `/rezics/query` and `/rezics/command` on the text dataset. `/rezics/update`
stays only until every Main writer uses the command endpoint, then it is removed.

The module is a `FusekiAutoModule` registered through
`META-INF/services/org.apache.jena.fuseki.main.sys.FusekiAutoModule`
([module mechanism](https://jena.apache.org/documentation/fuseki2/fuseki-modules.html)).
Its protocol is owned by the [storage binding](../storage/jena.md#transactional-command-endpoint).
The module gate proves the following on the built image:

- A valid write commits once.
- An invalid write aborts with no receipt, sequence, graph or text index change.
- An unmatched guard aborts.
- Of competing same-head commands, exactly one wins.
- `kill -9` during writes leaves TDB2 consistent and receipts reconcilable.
- jena-text reflects committed writes and never aborted ones.

If the module API cannot meet this gate, the fallback is a long-lived jena-shacl
validator process in the same image on a private port. It keeps the preflight
validation and guarded update protocol. Spawning a process per request is not
allowed in either design.

## Model pipeline

| Item | Status | Detail |
| --- | --- | --- |
| Authored IR | Adopted | TypeScript definitions in `model/definitions/*.ts`; the compiler lives in `model/compiler/` (workspace `@rezics/model`). The reviewed Turtle profiles are converted into the IR. |
| Generated artifacts | Adopted | `generated/model/shapes/*.ttl`, JSON-LD contexts and `generated/model/manifest.json` with SHA-256 per artifact; `packages/model/src/generated/` holds TypeBox schemas, TypeScript types, vocabulary/IRI constants, the profile registry (profile → shape, digest, focus roles) and fast-check arbitraries. |
| Equivalence | Adopted | Each existing profile's recorded conforming and rejected candidates must reproduce through the generated shapes and the command module before `model/tools/*.py`, `model/tests/*.py` and the hand-written Turtle are deleted. |
| JSON Schema, LinkML, Rust bindings | Stage when a consumer exists | Not generated in the first delivery. |

## API and clients

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| Elysia | 2.0.0-beta.16 | Adopted | Explicit TypeBox schemas for params, body and every response status. |
| TypeBox | 1.3.34 | Adopted | Schema library for Elysia and the generated model schemas. |
| `@elysia/openapi` | 2.0.0-beta.4 | Adopted | `yarn gen` writes `generated/openapi/<owner>/public.json`, using the default configuration (`provider: null` drops the JSON route). This is the published contract for external SDK/MCP consumers and a drift check. |
| `@elysia/eden` | 2.0.0-beta.5 | Adopted, gate | First-party web client. Main exports `type MainApp` through a type-only package export; the web imports no runtime service code. The gate requires the web typecheck against `MainApp` to finish in under 30 seconds on TypeScript 7, plus working calls from a Server Component and from a client component through the BFF proxy. |
| openapi-typescript / openapi-fetch | — | Not used | Revisit when an external TypeScript SDK ships. |
| Better Auth | 1.7.5 | Adopted | Account; plugin activation follows the [Account owner](../services/account.md). |
| pg | 8.23.0 | Adopted | PostgreSQL driver for Account/Access/relay. Kysely 0.29.6 stays inside Account's Better Auth integration only. |

## Web

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| vinext / `@vinext/cloudflare` | 1.0.0-beta.11 / 1.0.0-beta.9 | Adopted | App Router on Vite, deployed to Workers. |
| Vite, `@vitejs/plugin-rsc`, `@vitejs/plugin-react` | 8.3.0, 0.5.35, 6.1.1 | Adopted | Build pipeline required by vinext. |
| React, React DOM, `react-server-dom-webpack` | 19.3.0 | Adopted | UI runtime. |
| `@cloudflare/vite-plugin`, wrangler | 1.58.0, 4.137.0 | Adopted | Workers build and local `wrangler dev` (workerd) for end-to-end tests. |
| `@tanstack/react-query` | 5.103.2 | Adopted | Client components only; see [web organization](web-features.md#data-fetching). |
| Tailwind CSS, `@tailwindcss/vite` | 4.3.3 | Adopted | Styling. |
| SharkUI registry on Ark UI | `@ark-ui/react` 5.39.2 | Adopted | Components come from the SharkUI registry (`https://shark.vini.one/r/{name}.json`) into `packages/ui`, following the old repository's `libraries/ui` conventions. |
| `tailwind-variants`, `tailwind-merge`, `clsx`, `lucide-react` | 3.3.1, 3.7.0, 2.1.1, 1.47.0 | Adopted | UI utilities used by the SharkUI components. |
| `native-i18n` | 0.2.0 | Adopted | UI messages, as in the old repository. Lingui and Paraglide are not used. |
| `nuqs` | 2.10.1 | Adopted | URL search-parameter state for discovery and filters. |
| Tiptap 3 | — | Stage C | Wiki/block editing. |
| RJSF 6 | — | Stage E | Package parameter forms. |

## Tests and static checks

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| `bun test` | Bun 1.4.2 | Adopted | Backend unit, property, integration, model-based and recovery tests with `--parallel`, `--shard`, `--timings` and the JUnit reporter. |
| fast-check | 4.10.2 | Adopted | Properties, model-based command sequences, shrinking and logged seeds. |
| Vitest, `@vitest/browser-playwright` | 4.1.11 | Adopted | Storybook component tests. Vitest 5 is not used while `@storybook/addon-vitest` 10.6 accepts only `^3 \|\| ^4`. |
| Storybook | 10.6.0 (`storybook`, `@storybook/react-vite`, `@storybook/addon-vitest`, `@storybook/addon-a11y`) | Adopted | Component states and accessibility checks. |
| `@testing-library/react` | 16.3.3 | Adopted | Component interaction assertions. |
| msw | 2.15.0 | Adopted | Network mocks in stories and component tests only; never in backend integration tests. |
| `@playwright/test` | 1.63.0 | Adopted | End-to-end journeys against the local stack and `wrangler dev`. |
| k6 | 2.3.0 (image) | Adopted | Load tier. |
| Toxiproxy | 2.12.0 (image) | Adopted | Fault tier. |
| Biome | 2.5.14 | Adopted | Lint and format for TypeScript and JSON; ESLint and Prettier are not used. |
| dependency-cruiser | 18.4.0 | Adopted | Import boundaries: apps must not import service internals, Main modules use explicit interfaces, and browser code must not import server-only code. |
| Testcontainers, Polly, nock, Jest | — | Not used | The harness drives Docker Compose directly; remote fixtures use a content-addressed cache. |

## Continuous integration

`origin` is `github.com/rezics/rezics-next`. GitHub Actions running `yarn check`
and a sharded `yarn qa` is adopted once the harness passes locally. Renovate and
zizmor join at the same point. Syft and provenance attestations start at the first
release (stage G). Trivy is not used, per the survey's advisory note.

## Not used in the first delivery

Aspire (the copied `aspire` skill does not apply to this repository), Task/go-task,
Nx/Turbo, Redis, MinIO, openapi-fetch for the web, third-party Eden query wrappers
(`@ap0nia/eden-react-query`, `eden2query`), Vitest 5, Lingui, Paraglide, and Python
model validators. Operations tooling (pgBackRest, restic, OpenTelemetry Collector,
Prometheus, Grafana, VictoriaLogs, Caddy) is stage G; recheck versions from the
survey when that stage starts.
