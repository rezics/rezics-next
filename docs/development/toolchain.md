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
- **One command facade.** Root `yarn` commands are the entry points agents and
  developers use. `toolchain:install` is a dependency-free, checked-in Yarn
  plugin command because Yarn's node-modules linker cannot launch package
  scripts before the first install. All other root commands remain
  `package.json` scripts. Nx, Turbo, Task/go-task and Aspire are not used.
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

### Architecture evaluation exception (2026-09-24)

The maintainer requested executable architecture research before resuming P0.1.
The following tools are admitted only for disposable comparisons, not selected
as product dependencies. All generated data, downloads, logs and processes are
scoped to `.temp/storage-architecture/`; existing services and datasets are not
modified. Evidence must record actual versions, storage, request counts and
limitations. Reuse installed binaries where their versions match.

| Tool | Research pin | Reason and qualification |
| --- | --- | --- |
| PostgreSQL native utilities | 18.6 | Isolated loopback clusters with fsync on; compare JSON payload reads and transactional publication. |
| OpenJDK | 25.0.4.1 | Installed research JVM, matching the earlier Jena CJK probe; this does not replace production Java 21. |
| Jena embedded/Fuseki server jar | 6.2.0; `jena-fuseki-server` SHA-1 `d3490295a2b95677c1227d25bca8564d40f993a7` | Reuse the prior pinned artifact for graph/text HTTP comparisons. |
| Fluree | 4.2.1, source commit `82dbcec3e435d6ed1d45bc0ed929432323b6b201` | Candidate graph authority; verify downloaded release checksum before execution. |
| Dgraph research container | `docker.io/dgraph/dgraph:v25.4.1`, release commit `759e242be62c91f8d084da06ad0c8d21256d9c07`; inspected image ID `023abcb91868d151df1889342041529670580773b8de48a48d2bb6dd466007d0`, manifest digest `sha256:056bd94a3cd67da552fe6ddb575a1d6f0b5597eb9d96da73827bcb1e80cf5f8f` | Bounded challenger probe of relation occurrences, scoped selection and application-owned history/CAS, requested during the broader architecture review. Run an isolated Zero/Alpha pair or standalone mode with the admitted Podman runtime, private loopback endpoints and `.temp/storage-architecture/dgraph/` data; never touch product services. `dgraph --prepare-only` inspected the image before execution. [Release](https://github.com/dgraph-io/dgraph/releases/tag/v25.4.1). |
| fluree-sql-bridge | Source from the same Fluree commit; package version 4.1.6 | Candidate SQL federation; compile with its checked-in lockfile and record source digest. |
| Rust / Cargo | 1.98.1 | Build the upstream SQL bridge only, with `--locked`; no product Rust dependency is adopted. |
| Docker CLI | 29.8.1 | Inspect local images and run disposable search comparison containers; record image digests before use. |
| Host inspection/archive utilities | Installed `lscpu`, `df`, `tar` | Read host/storage metadata and extract checksum-verified upstream archives through the research runner. |
| Podman | 5.8.7 | Disposable rootless search containers and image inventory; Docker Desktop is unavailable on this host. |
| PGroonga research image | PostgreSQL 18.6 / PGroonga 4.0.8; local image ID `df9394ae660618227f519eeb0c2a4d9721c0b590ffaf4c49652747a601c1bf91`, manifest digest `sha256:c8052fbed36391ce9c01825ede5f70d78ddac575ae00b2c2f6f72642736afe81` | Reuse the old repository's inspected image with a new isolated data directory; verify extension version inside the probe. |
| OpenSearch research image | `docker.io/opensearchproject/opensearch:3.6.0`; image ID `b1b447d0d021b051fdb1ae6be100e106667bbe302aa8d6855a4f6d726863d766`, manifest digest `sha256:b5dd1512af2a99748c942cfbbd7f32162623336b210667d0fc6333c6321f171d` | Isolated relation-aware ranked-search probe using the existing Podman runtime. Verify and retain image identity before measuring, run by that ID, and verify server version. This is a research pin, not a claim of the newest release or a production selection. [Release](https://opensearch.org/blog/introducing-opensearch-3-6/). |
| Virtuoso Open Source research image | `docker.io/openlink/virtuoso-opensource-7:7.2.17-r25-g6eb68b6-ubuntu`; image ID `a6cbc2c869d23c04b131fa2c0e1663abc347747f12efe9bd62453eab1ea8575e`, manifest digest `sha256:2a9914b95f8a52927a73947c87ec2727f78f87d38e41c38c379efb121f9cbed1`. The initially inspected `7.2.17-r25.1-g2850f18-ubuntu` image (ID `07263730abf06071e50b89b03c0f027cd37e3205df13134ace7dc97bb5817d08`, digest `sha256:0dbe1ab4fa0cb7bbafc1f6c0c2b0a5d6f22d918dbd17672f2ddb24580aa6756a`) was rejected because its binary reports `7.2.18-dev.3243` (`8439c5e52f`) despite the tag. | Disposable native RDF plus free-text challenger on loopback only, with data under `.temp/storage-architecture/virtuoso/`. Run by inspected image ID and verify binary version. This is research, not a product dependency. [Release](https://github.com/openlink/virtuoso-opensource/releases/tag/v7.2.17), [official image](https://hub.docker.com/r/openlink/virtuoso-opensource-7/tags). |

`yarn research:architecture inspect|prepare|graph|search|opensearch|bridge|dgraph|virtuoso|report` is the only
research execution entry point. `inspect` reads tool/service inventory; `prepare`
downloads/verifies the pinned engines and builds the bridge; the other commands
run maintained probes. `report --retain` copies selected raw results and tool
metadata to the dated research evidence directory. Probe correctness tests run
with `yarn test <research-test-path>`.
`dgraph --prepare-only` may pull/inspect the pinned image without starting it;
record the digest above before `dgraph` executes the bounded challenger. This
probe does not qualify distributed scale or change the production selection.
`opensearch` pulls/inspects the pinned image if needed and runs only a disposable
loopback-bound container, retaining fixture/query/latency/update evidence under
`.temp/storage-architecture/opensearch/`. It must clean up its own container and
never change the application's services or host-wide kernel settings.
`virtuoso --prepare-only` may pull and inspect the pinned image without starting
it; record the resulting image ID and manifest digest above before executing the
bounded probe. The probe retains its queries, results and logs under
`.temp/storage-architecture/virtuoso/` and removes its container.
The documented supplements `search --pg-contains-control` and
`GRAPH_POST_INDEX=1 yarn research:architecture graph` reuse only retained probe
databases. `search --report-only` refreshes explanation text without remeasurement.
`REZICS_BRIDGE_SNAPSHOT=1 yarn research:architecture bridge` runs the controlled
concurrent-update counterexample and preserves the prior timing baseline.
`yarn check` remains a bootstrap check of existing workspace types, the external
Eden Main consumer, research types, documentation and `gen:check`; it does not claim the planned Biome or
dependency-cruiser gates are implemented. P0.3 `yarn gen` generates the 12
reviewed Turtle shapes from authored TypeScript IR with stable digests, plus
JSON-LD contexts and node-local TypeBox/types/arbitraries. The isolated
cmd0.4.0 image reproduced all 66 recorded candidate outcomes and report paths
through the QA model tier. The handwritten Turtle/Python validators are retired.
`yarn docs:check` runs the documentation checker and its regression
tests. The P0.4 `yarn qa` core runs static, unit, shared-stack integration,
isolated model, fault/recovery, load and built-Worker browser tiers with an
acceptance inventory. Successful `--record` qualification remains pending. Entries below
describe the target command surface; incomplete entries are called out explicitly.

| Command | Effect |
| --- | --- |
| `yarn toolchain:install` | From a clean clone, runs Yarn's immutable install before loading workspace code; then checks Docker, Bun and Node, pulls pinned images, builds the Fuseki image and installs the Playwright Chromium build. Idempotent. The checked-in `.yarn/plugins/rezics-bootstrap.cjs` implements only this pre-install command and adds no runtime dependency. |
| `yarn stack:up [--profile dev\|qa]` | Starts the Compose project for local services and prints generated endpoints. `stack:down` and `stack:reset` stop it or remove its volumes. |
| `yarn stack:logs [--profile dev\|qa]` | Prints a bounded tail of service logs for startup and health diagnostics. |
| `yarn stack:status [--profile dev\|qa]` | Shows the current service state and health for a saved local project. |
| `yarn dev [--profile qa --run-id <id>]` | Runs `stack:up`, then Main and Account in watch mode on the host; it starts the web workspace when present. The isolated QA profile creates or loads a disposable local OAuth client and Access actor, then launches services with their registered credentials. |
| `yarn gen` | Generates reviewed Turtle profiles, JSON-LD contexts, TypeBox schemas/types, vocabulary, arbitraries and registry from TypeScript IR, plus Main's public OpenAPI JSON; `yarn gen:check` detects drift. |
| `yarn check` | Runs Main, Account, Content, model, UI and web workspace typechecks, the external Eden Main consumer gate, research types, `gen:check` and docs checks; Biome and dependency-cruiser are pending. Target under 2 minutes. |
| `yarn test <paths> [-t <ID>]` | Runs explicit unit files through Bun; registered QA integration, model, fault/recovery and load files route through their isolated tiers, with an optional acceptance ID. Other legacy integration files retain their explicit environment requirements until migrated. |
| `yarn content:typecheck` | Checks the P0.8 Content owner workspace with the adopted TypeScript pin. |
| `yarn qa` | Runs static, unit, integration, model, fault/recovery, built-Worker e2e plus Storybook browser tests, and load tiers, including `yarn check`. The 30-minute full-suite target and `--record` qualification path are pending. |
| `yarn fixtures:pull` | Planned remote fixture-cache refresh; command pending. |
| `yarn load` | Planned standalone k6 profile; command pending. |
| `yarn docs:check` | Runs the Python documentation checker and its regression tests. |
| `yarn web:build` | Builds the vinext Workers application for deployability checks. |
| `yarn web:preview --profile qa --run-id <id>` | Builds the web Worker with the selected running isolated stack's endpoints and registered local OAuth client when present, then starts its generated output under local `wrangler dev` on port 3003 for browser journeys. |
| `yarn web:e2e` | Runs Playwright Chromium against the running built Worker preview and its isolated QA stack. |
| `yarn storybook` | Runs the web component review server on loopback port 6006. |
| `yarn storybook:test` | Runs web Storybook stories in Vitest browser mode with Playwright Chromium and a11y addon checks. |

P0.8's first Content owner reuses the adopted TypeScript 7.0.2 and pg 8.23.0
pins. Its typecheck and transactional integration test are registered in the
central check and QA integration tiers.

Dev and QA secrets are generated per Compose project into `.temp/stack/<project>/`
and never committed. SOPS/age apply at the deployment stage.

## Runtimes and languages

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| Bun | 1.4.2 | Adopted | Main, Account, harness scripts and backend tests (`bun test`). |
| Node.js | 26.8.2 (`.nvmrc`) | Adopted | Yarn, Vite/vinext, Storybook, Vitest, Playwright and wrangler. |
| Yarn | 4.18.0, `nodeLinker: node-modules` | Adopted | One lockfile for all workspaces; a small local plugin registered in `.yarnrc.yml` provides the pre-install `toolchain:install` command. |
| TypeScript | 7.0.2 | Adopted | `tsc --noEmit` per workspace. |
| Java | Temurin 21 JRE in `eclipse-temurin:21.0.12_8-jre-noble` | Adopted | Fuseki runtime inside its image; no host Java required. |
| Maven | `maven:3.9.16-eclipse-temurin-21` build stage | Adopted | Builds the Fuseki command module inside the image build. |
| Python | 3.10+ standard library | Adopted, docs only | The [documentation checker](README.md). The Python model validators are retired by Phase 0. |
| Docker CLI / Compose | 29.8.1 / 5.5.1 | Adopted | Root facade for pinned image build, local service lifecycle and disposable QA projects. The Compose version supports the QA overlay's `!override` and `!reset` tags; both configurations resolved and the dev stack started on 2026-09-25. |
| Podman | 5.8.7 | Adopted local fallback | User-socket Docker API where Docker Engine is unavailable on this host; verified with the P0.1 stack startup and teardown. |

## Local services

Docker Compose runs third-party services and databases. Main, Account and the
web app run as host processes for fast reload in development and are started by
the harness for end-to-end and load tiers. They are not containerized in the
first delivery; production placement stays with [deployment](../operations/deployment.md).

On the current development host Docker Engine is installed but its daemon is
inactive and cannot be started without administrator access. Podman 5.8.7 is an
adopted local Docker-API fallback for the same root `docker compose` commands,
using its user socket and `DOCKER_HOST`; the root command facade selects it only
after a Docker daemon probe fails. This does not change the Compose topology or
production runtime. P0.1 verified the Fuseki image build, Compose startup,
Main/Account readiness and teardown through this socket on 2026-09-25. A fresh
clone with no Yarn install state then ran `yarn toolchain:install && yarn dev`;
Main and Account each returned HTTP 200 from `/health/ready`, and the stack was
stopped without removing volumes. The observed host check was Docker CLI
29.8.1/Compose 5.5.1 with both Docker daemon
sockets absent, Podman 5.8.7 available, and `docker.socket` requiring an
unavailable administrator password. The P0.1 clean-clone command exit is met;
the broader OPS01/OPS14/OPS16 acceptance cases remain in the QA program.
The disposable QA overlay uses permissive tmpfs mount modes because this Podman
Docker API rejects Compose `uid`/`gid` tmpfs options; the services remain isolated
inside the per-run Compose project.

The topology lives in `infra/dev/compose.yaml` (project `rezics-dev`, or
`rezics-qa-<run>` for the harness). Every published port binds to `127.0.0.1`.
Development uses named volumes; QA uses tmpfs except in the recovery tier.

| Service | Image | Status | Purpose |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:18.6-trixie` | Adopted | One cluster with separate logical owners and login roles for Content, Account, Access and operations/relay. Content holds bounded body bytes/JSONB, revisions, drafts, publication pins and local receipts/outbox. P0.8 adds that binding. `wal_level=replica` and WAL archiving support PITR drills; initial polling needs no logical-decoding extension. Init SQL lives in `infra/dev/postgres/`. |
| Fuseki | `rezics/fuseki:6.2.0-cmd0.5.4`, built locally | Adopted | TDB2 + jena-text with the REZICS command module and generated shapes; cmd0.5.4 adds fixed Content MatchUnit projection, narrowly admitted public MatchUnit shape validation, and public eligibility linkage checks while retaining Content publication and historical binding outcomes. This host's BuildKit/Compose path has kept serving already tagged Podman images after rebuild; a changed module uses a fresh image tag. |
| Object storage | `rustfs/rustfs:1.0.0` | Adopted, gate | S3 API for sealed semantic payloads/manifests, large Content pages, media and artifacts. Ordinary bounded bodies/revisions move to PostgreSQL in P0.8; preserve exact references when replacing the filesystem baseline. |
| Fault proxy | `ghcr.io/shopify/toxiproxy:2.12.0` | Adopted (QA) | Latency, timeout, reset and lost-response faults between the apps and Fuseki/PostgreSQL, controlled through its HTTP API. |
| Mail sink | `axllent/mailpit:v1.31.2` | Adopted | SMTP sink for Account email; tests read messages through its HTTP API. |
| Load generator | `grafana/k6:2.3.0` | Adopted | Run with `docker run --rm --add-host=host.docker.internal:host-gateway`. |

The object storage gate proves conditional create (`If-None-Match: *`), checksum
verification, concurrent writers of one key and restore against RustFS through
Main's adapter. Bun 1.4.2 `S3Client` has no custom-header option for the required
conditional create, so the documented fallback, `aws4fetch` 1.0.20 signed
`fetch`, is selected for this gate's writes and reads. Its read path also avoids
the [Bun S3Client local proxy issue](https://github.com/oven-sh/bun/issues/32045)
observed on this host. Verify conditional creation and read-back against RustFS
before accepting the adapter. Choosing the production object backend remains
under [object storage](../storage/objects.md).

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
| Equivalence | Adopted | The cmd0.5.4 module retains fixed exact focus/link bindings for five historical profiles; Content publication, MatchUnit projection and public eligibility have separate generated profiles and fixed poststate checks. The strict QA model tier must still match all 66 recorded outcomes and result paths; generated digests, TypeScript fixtures and historical reports remain. Handwritten Turtle/Python validators are retired. |
| JSON Schema, LinkML, Rust bindings | Stage when a consumer exists | Not generated in the first delivery. |

## API and clients

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| Elysia | 2.0.0-beta.16 | Adopted | Explicit TypeBox schemas for params, body and every response status. |
| TypeBox | 1.3.34 | Adopted | Schema library for Elysia and the generated model schemas. |
| aws4fetch | 1.0.20 | Adopted for P0.5 | Sign S3 object writes and reads. Immutable creation sends `If-None-Match: *` to RustFS; signed `fetch` reads bypass Bun S3Client's observed local proxy issue. |
| `@elysia/openapi` | 2.0.0-beta.4 | Adopted | `yarn gen` writes `generated/openapi/main/public.json` from the live route schemas, excluding health routes and adding documented bearer/idempotency headers. `provider: null` drops the JSON route, so generation uses the default provider in an ephemeral app. `gen:check` detects drift. |
| `@scalar/types` | 0.18.3 | Adopted | Type-only peer required by the pinned OpenAPI plugin; the generated contract does not publish a Scalar UI. |
| `@elysia/eden` | 2.0.0-beta.5 | Adopted, gate | Main exports `type MainApp` through a type-only package export. `yarn check` compiles an external Eden consumer under 30 seconds on TypeScript 7; Server Component and client BFF calls remain P0.6 work. |
| openapi-typescript / openapi-fetch | — | Not used | Revisit when an external TypeScript SDK ships. |
| Better Auth | 1.7.5 | Adopted | Account; plugin activation follows the [Account owner](../services/account.md). |
| pg | 8.23.0 | Adopted | PostgreSQL driver for Content/Account/Access/operations/relay. Kysely 0.29.6 stays inside Account's Better Auth integration only. |

## Web

| Tool | Version | Status | Use |
| --- | --- | --- | --- |
| vinext / `@vinext/cloudflare` | 1.0.0-beta.11 / 1.0.0-beta.9 | Adopted | App Router on Vite, deployed to Workers. |
| Next.js package/types | 16.3.6 | Adopted for P0.6 | Supplies App Router TypeScript declarations to vinext; runtime rendering remains vinext. |
| Vite, `@vitejs/plugin-rsc`, `@vitejs/plugin-react` | 8.3.0, 0.5.35, 6.1.1 | Adopted | Build pipeline required by vinext. |
| React, React DOM, `react-server-dom-webpack` | 19.3.0 | Adopted | UI runtime. |
| `@types/react`, `@types/react-dom` | 19.2.18, 19.2.7 | Adopted for P0.6 | TypeScript JSX declarations. |
| `@types/node` | 26.6.2 | Adopted for P0.6 | Worker build and tool configuration declarations for Node compatibility APIs. |
| webpack | 5.110.3 | Adopted for P0.6 | Peer runtime for the pinned React Server Components transport package. |
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
| `@playwright/test`, `playwright` | 1.63.0 | Adopted | End-to-end journeys against the local stack and `wrangler dev`; Vitest's browser provider uses Playwright. |
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

The selected startup storage is PostgreSQL + Jena/TDB2 with embedded
jena-text/Lucene. OpenSearch, PGroonga, pg_bigm, Kafka, Flink, Debezium and other
research engines are not required product dependencies. Research pins above do
not select them. The body projection uses existing RDF MatchUnits and the text
wrapper, not a separate process writing Lucene files. Required components must
be self-hosted open-source or suitable source-available software.

Aspire (the copied `aspire` skill does not apply to this repository), Task/go-task,
Nx/Turbo, Redis, MinIO, openapi-fetch for the web, third-party Eden query wrappers
(`@ap0nia/eden-react-query`, `eden2query`), Vitest 5, Lingui, Paraglide, and Python
model validators. Operations tooling (pgBackRest, restic, OpenTelemetry Collector,
Prometheus, Grafana, VictoriaLogs, Caddy) is stage G; recheck versions from the
survey when that stage starts.
