# Toolchain and root commands

This is the maintainer entry point for tools used by this checkout. The tables
below come from the root and workspace manifests, release/runtime pins, Aspire
config, Compose, the Fuseki Dockerfile and `Taskfile.yml`. The
[toolchain survey](../research/toolchain-survey.md) records alternatives and
revisit reasons; it does not select dependencies.

## Prerequisites and pin changes

Install the Bun, Node.js and Task versions in the generated runtime table, a
Docker-compatible daemon, and Python 3.10+ for documentation checks. The
[installation guide](../operations/installation.md) gives the clean-checkout
procedure. Host Java is unnecessary: the Fuseki image builds and runs it.
A few integration tests start a host PostgreSQL 18 with `initdb`; install the
server and its contrib extensions (Fedora: `postgresql-server postgresql-contrib`)
because Content migrations create `pg_trgm`.

Task is the command facade for developers and agents. Run `task --list`; pass
extra arguments after `--`. Yarn installs dependencies with `task install` or
`task toolchain:install`; it does not run application commands. The lockfile is
the source for transitive package versions. Root and workspace package manifests
use exact direct pins; Compose and Dockerfiles pin external images by digest.
The locally built Fuseki image has a content-addressed tag derived by
`scripts/dev/fuseki-image.ts` and checked by `task gen:check`.

When adding or replacing a tool, update its owning manifest/configuration, the
lockfile or image digest where applicable, and the reason and verification in
the owning change. Regenerate this page with
`python3 scripts/documentation/toolchain_inventory.py --write`; `task docs:check`
rejects a stale table. For native install scripts, inspect the script and add
only the required package to `dependenciesMeta.<name>.built`; Yarn's global
`enableScripts` remains disabled. The repository uses a private TypeScript 6
parser for dependency-cruiser through `.yarnrc.yml`; product typechecks use the
TypeScript version in their manifests.

`task dev` starts the shared local stack through Aspire in the main checkout.
In a worktree it starts the Accounts app, web app and Storybook on allocated
ports against the shared backend; `task dev -- --backend` creates an isolated
backend. Use `task urls` for addresses. The Accounts app is the public Account
origin. `task env` masks local secrets;
workspace `.env.example` files show variables. Personal overrides belong in
the ignored root `.env.dev`, not `.env` or `.env.local`, which Bun can load into
unrelated processes.

## Architecture evaluation exception (2026-09-24)

The [storage research runner](../../scripts/research/storage_architecture/README.md)
admits native PostgreSQL, Java, Rust, Podman and candidate engines only for
disposable comparisons. Its scripts pin images and downloaded artifacts and
verify them before execution. Data, downloads and logs belong under
`.temp/storage-architecture/`; product services and datasets are untouched.
The PGroonga comparison needs the inspected local image
`rezics-postgres:18.6-pgroonga-4.0.8` (ID
`df9394ae660618227f519eeb0c2a4d9721c0b590ffaf4c49652747a601c1bf91`,
digest `sha256:c8052fbed36391ce9c01825ede5f70d78ddac575ae00b2c2f6f72642736afe81`);
the runner reports its absence rather than treating that comparison as a pass.

## Runtimes and languages

<!-- toolchain-inventory:start -->

### Runtime pins

| Tool | Pin | Source |
| --- | --- | --- |
| Bun | 1.4.2 | scripts/dev/release-manifest.ts |
| Node.js | 26.8.2 | .nvmrc |
| Yarn | yarn@4.18.0 | package.json |
| Task | 3.53.1 | scripts/dev/cli.ts |
| Aspire SDK | 13.5.4 | aspire.config.json |
| Go package oracle | 1.27.1 | scripts/package/go-oracle.ts |
| Cargo package oracle | 1.98.1 | scripts/package/cargo-oracle.ts |
| npm package oracle | 11.19.1 | scripts/package/npm-oracle.ts |

### Direct workspace packages

Exact direct pins from root and workspace manifests; `yarn.lock` resolves transitive dependencies.

| Package | Pin | Manifest directories |
| --- | --- | --- |
| @ark-ui/react | 5.39.2 | packages/ui |
| @ast-grep/cli | 0.45.3 | . |
| @better-auth/core | 1.7.5 | services/account |
| @better-auth/oauth-provider | 1.7.5 | services/account |
| @better-auth/passkey | 1.7.5 | services/account |
| @better-auth/utils | 0.4.2 | services/account |
| @better-fetch/fetch | 1.3.2 | services/account |
| @cloudflare/vite-plugin | 1.58.0 | apps/accounts, apps/web |
| @elysia/eden | 2.0.0-beta.5 | apps/web, services/account, services/main |
| @elysia/openapi | 2.0.0-beta.4 | services/account, services/main |
| @fontsource-variable/geist-mono | 5.3.0 | apps/web |
| @fontsource-variable/manrope | 5.3.0 | apps/accounts, apps/web |
| @fontsource-variable/source-serif-4 | 5.3.0 | apps/web |
| @js-temporal/polyfill | 0.5.1 | services/main |
| @microsoft/aspire-cli | 13.5.4 | apphost |
| @playwright/test | 1.63.0 | . |
| @rezics/account | workspace:* | apps/accounts |
| @rezics/main | workspace:* | apps/web |
| @rezics/ui | workspace:* | apps/accounts, apps/web |
| @rezics/zone-sdk | workspace:* | apps/web |
| @scalar/types | 0.18.3 | services/account, services/main |
| @storybook/addon-a11y | 11.0.0-alpha.1 | apps/accounts, apps/web |
| @storybook/addon-mcp | 11.0.0-alpha.1 | apps/web |
| @storybook/addon-vitest | 11.0.0-alpha.1 | apps/accounts, apps/web |
| @storybook/react-vite | 11.0.0-alpha.1 | apps/accounts, apps/web |
| @tailwindcss/vite | 4.3.3 | apps/accounts, apps/web |
| @tanstack/react-query | 5.103.2 | apps/web |
| @types/bun | 1.4.2 | apps/accounts, packages/model, services/account, services/content, services/main |
| @types/node | 26.6.2 | apphost, apps/accounts, apps/web |
| @types/nodemailer | 8.0.2 | services/account |
| @types/pg | 8.23.1 | services/account, services/content, services/main |
| @types/react | 19.2.18 | apps/accounts, apps/web, packages/ui, packages/zone-sdk |
| @types/react-dom | 19.2.7 | apps/accounts, apps/web, packages/ui |
| @vinext/cloudflare | 1.0.0-beta.9 | apps/web |
| @vitejs/plugin-react | 6.1.1 | apps/accounts, apps/web |
| @vitejs/plugin-rsc | 0.5.35 | apps/accounts, apps/web |
| @vitest/browser-playwright | 5.0.2 | apps/accounts, apps/web |
| aws4fetch | 1.0.20 | services/main |
| axe-core | 4.13.0 | apps/web |
| better-auth | 1.7.5 | services/account, services/main |
| better-call | 1.4.0 | services/account |
| dependency-cruiser | 18.4.0 | . |
| drizzle-orm | 0.45.3 | services/content |
| elysia | 2.0.0-beta.16 | apps/web, services/account, services/main |
| envalid | 8.2.0 | apps/accounts, apps/web, services/account, services/main |
| exact-mirror | 1.2.6 | services/account, services/main |
| fast-check | 4.10.2 | packages/model |
| jose | 6.2.12 | services/account, services/main |
| knip | 6.38.0 | . |
| kysely | 0.29.6 | services/account |
| lucide-react | 1.47.0 | apps/accounts, apps/web, packages/ui |
| nanostores | 1.5.3 | services/account |
| native-i18n | 0.2.0 | apps/accounts, apps/web |
| next | 16.3.6 | apps/accounts, apps/web |
| nodemailer | 10.0.10 | services/account |
| nuqs | 2.10.1 | apps/web |
| openapi-types | 12.1.3 | services/account, services/main |
| oxfmt | 0.70.0 | . |
| oxlint | 1.85.0 | . |
| oxlint-tsgolint | 7.0.2003 | . |
| pg | 8.23.0 | services/account, services/content, services/main |
| playwright | 1.63.0 | apps/accounts, apps/web |
| react | 19.3.0 | apps/accounts, apps/web, packages/ui, packages/zone-sdk |
| react-dom | 19.3.0 | apps/accounts, apps/web, packages/ui |
| react-is | 19.3.0 | packages/ui |
| react-server-dom-webpack | 19.3.0 | apps/accounts, apps/web |
| recharts | 3.10.1 | packages/ui |
| storybook | 11.0.0-alpha.1 | apps/accounts, apps/web |
| tailwind-variants | 3.3.1 | packages/ui |
| tailwindcss | 4.3.3 | apps/accounts, apps/web |
| tsx | 4.23.13 | apphost |
| tw-animate-css | 1.4.0 | packages/ui |
| typebox | 1.3.34 | packages/model, services/account, services/main |
| typescript | 7.0.2 | apphost, apps/accounts, apps/web, packages/model, packages/ui, packages/zone-sdk, services/account, services/content, services/main |
| vinext | 1.0.0-beta.11 | apps/accounts, apps/web |
| vite | 8.3.0 | apps/accounts, apps/web |
| vitest | 5.0.2 | apps/accounts, apps/web |
| vscode-jsonrpc | 8.2.1 | apphost |
| webpack | 5.110.3 | apps/accounts, apps/web |
| wrangler | 4.137.0 | apps/accounts, apps/web |

### Service and Fuseki build images

| Source | Image and digest |
| --- | --- |
| Compose | postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 |
| Compose | rezics/fuseki:6.2.0-cmd0.5.34-7857db6447c8 |
| Compose | rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff |
| Compose | ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e |
| Compose | axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d |
| Fuseki build | maven:3.9.16-eclipse-temurin-21@sha256:c2a2c58516d160f43b50f12baa427ca86989e0bc942609e04aff61da5d9a7d74 |
| Fuseki build | eclipse-temurin:21.0.12_8-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f |

### Other pinned images

| Use | Image pin |
| --- | --- |
| Nix package oracle | docker.io/nixos/nix:2.35.2@sha256:617d914dba5384bf75adf17081583b69371031ec7defce36c34c5fa14fc819b0 |
| Node package hooks | docker.io/library/node:26.8.2-bookworm-slim@sha256:6e685d638c472d81fdf86b944e3487f0d3b5e747d5099f936d4d2256cd1201d5 |
| Load generator | grafana/k6:2.3.0 |
| API fuzz | docker.io/schemathesis/schemathesis:4.28.0@sha256:0a71757c60ccdba270c154a859d9dd3d019625f782f23ab36ad604771e15f78b |
| Research: dgraph | docker.io/dgraph/dgraph:v25.4.1 (docker.io/dgraph/dgraph@sha256:056bd94a3cd67da552fe6ddb575a1d6f0b5597eb9d96da73827bcb1e80cf5f8f) |
| Research: opensearch | docker.io/opensearchproject/opensearch:3.6.0 (docker.io/opensearchproject/opensearch@sha256:b5dd1512af2a99748c942cfbbd7f32162623336b210667d0fc6333c6321f171d) |
| Research: virtuoso | docker.io/openlink/virtuoso-opensource-7:7.2.17-r25-g6eb68b6-ubuntu (docker.io/openlink/virtuoso-opensource-7@sha256:2a9914b95f8a52927a73947c87ec2727f78f87d38e41c38c379efb121f9cbed1) |

### Shared development ports

| Setting | Port |
| --- | --- |
| ACCOUNTS_PORT | 3004 |
| ACCOUNT_PORT | 3002 |
| FUSEKI_PORT | 3030 |
| MAILPIT_HTTP_PORT | 8025 |
| MAILPIT_SMTP_PORT | 1025 |
| MAIN_PORT | 3001 |
| POSTGRES_PORT | 5432 |
| RUSTFS_CONSOLE_PORT | 9001 |
| RUSTFS_PORT | 9000 |
| TOXIPROXY_API_PORT | 8474 |
| TOXIPROXY_FUSEKI_PORT | 13030 |
| TOXIPROXY_POSTGRES_PORT | 15432 |

### Root commands

Pass command arguments after `--`; run `task --list` for the live command menu.

| Command | Task description |
| --- | --- |
| `task default` | List the available commands. |
| `task install` | Install the pinned workspace dependencies from the lockfile. |
| `task toolchain:install` | From a clean clone, install dependencies, check runtimes, pull images, build Fuseki and install Chromium. |
| `task dev` | Start the dev environment under Aspire. Main checkout: shared backend and frontend on ports 3002 (Account), 3001 (Main), 3004 (Accounts app), 3000 (web), 6006 (Storybook). Worktree: Accounts app, web and Storybook on random ports against it, or -- --backend for its own isolated stack. |
| `task dev:stop` | Stop this checkout's AppHost; a worktree backend also removes its isolated stack. |
| `task dev:reset` | Print and, with -- --yes, recreate only this checkout's dev stack data. |
| `task urls` | Show this checkout's running resources with their URLs and health. |
| `task env` | Show the application environment this checkout uses, secrets masked, and where it comes from. |
| `task env:example` | Regenerate each workspace's .env.example from its envalid config specs. |
| `task zones:digest` | Compute the digest of an installed official Zone source package. |
| `task dev:prepare` | Start storage, apply migrations and write the application environment without starting processes. |
| `task dev:seed` | Seed this checkout's local demo through its public APIs. |
| `task dev:typecheck` | Type-check the development scripts. |
| `task aspire` | Run the pinned Aspire CLI against the dev AppHost (describe, logs, wait, agent mcp, ...). |
| `task aspire:restore` | Generate the TypeScript AppHost SDK for the pinned Aspire version. |
| `task stack:up` | Start the Compose storage stack and print its endpoints. |
| `task stack:down` | Stop the Compose storage stack and keep its data. |
| `task stack:reset` | Stop the Compose storage stack and remove its volumes. |
| `task stack:logs` | Print recent Compose service logs. |
| `task stack:status` | Show Compose service status. |
| `task stack:backup` | OPS03 fixture only; take a physical PostgreSQL backup of a disposable owner-cut QA stack. |
| `task stack:clone` | Copy a stopped persistent load stack into a new isolated QA project. |
| `task web:dev` | Run vinext alone, without Aspire, against the shared backend (defaults in apps/web/.env.example; pass -- --port <n>). |
| `task web:build` | Build the vinext Workers application. |
| `task web:preview` | Build the web Worker for a running QA stack and serve it with wrangler on port 3003. |
| `task web:e2e` | Run Playwright journeys against the running web preview. |
| `task web:typecheck` | Type-check the web workspace. |
| `task storybook` | Run Storybook on port 6006 with its MCP endpoint at /mcp. |
| `task storybook:build` | Build static Storybook into .temp/storybook/static. |
| `task storybook:test` | Run Storybook stories as Vitest browser tests with accessibility checks. |
| `task accounts:dev` | Run the Accounts app alone with vinext, without Aspire, against the shared Account service (defaults in apps/accounts/.env.example; pass -- --port <n>). |
| `task accounts:build` | Build the Accounts vinext Workers application. |
| `task accounts:typecheck` | Type-check the Accounts workspace. |
| `task accounts:storybook` | Run the Accounts Storybook on port 6007. |
| `task accounts:storybook:test` | Run the Accounts stories as Vitest browser tests with accessibility checks. |
| `task accounts:e2e` | Run the Accounts Playwright journeys against a running Accounts app (ACCOUNTS_URL, default http://127.0.0.1:3004). |
| `task ui:typecheck` | Type-check Rezics UI. |
| `task check` | Run every static gate (types, generated contracts, docs, lint, format, code shape, unused files, imports). |
| `task check:backend` | Run the static gates without UI and web sources. |
| `task check:unused` | Report unused files, dependencies and exports with Knip. |
| `task ast-grep` | Run the pinned ast-grep binary (scan or test) with sgconfig.yml. |
| `task docs:check` | Check documentation links, fragments and navigation. |
| `task i18n:check` | Report locale catalog gaps and fail on extra keys or insert placeholder mismatches. |
| `task test` | Run explicit test files or the affected plan (-- --affected [<base>] [--list]). |
| `task qa` | Run the QA harness tiers (-- --backend, --tier, --record, ...). |
| `task qa:replay` | Replay one property or model test with a logged seed. |
| `task api:fuzz` | Run Schemathesis against Main's generated OpenAPI contract on an isolated stack. |
| `task gen` | Regenerate model, OpenAPI and pinned-image artifacts and the toolchain inventory. |
| `task gen:check` | Fail if generated artifacts are stale. |
| `task fixture:build` | Build a deterministic background corpus into owner storage. |
| `task fixture:restore` | Restore a fixture backup into a new persistent QA stack. |
| `task fixtures:pull` | Replay verified factual fixtures from the cache or committed seed. |
| `task load` | Run the mixed host load profile. |
| `task load:prepare` | Build a reusable command-created load baseline. |
| `task load:clone-probe` | Probe a cloned load stack for isolation and fresh commands. |
| `task release:build` | Package a content-addressed local release artifact. |
| `task release:install` | Verify a release artifact and provision a project from it. |
| `task search:rebuild` | Rebuild the public search index on a stopped-writer stack. |
| `task access:pending-search` | List unresolved private search deliveries (needs ACCESS_DATABASE_URL). |
| `task research:architecture` | Run the storage architecture research lab. |
| `task package:go-oracle` | Compare Go module resolution with the pinned native Go. |
| `task package:go-probe` | Run the Go provider probe. |
| `task package:go-checksum-oracle` | Compare Go checksum provenance with the pinned native Go. |
| `task package:cargo-oracle` | Compare Cargo resolution with the pinned native Cargo. |
| `task package:npm-oracle` | Compare npm lockfile topology with the pinned native npm. |
| `task account:dev` | Run Account in watch mode. |
| `task account:test` | Run Account unit tests. |
| `task account:typecheck` | Type-check Account. |
| `task content:typecheck` | Type-check Content. |
| `task content:test` | Run Content unit tests. |
| `task main:dev` | Run Main in watch mode. |
| `task main:relay` | Run the Main relay. |
| `task main:relay:init` | Initialize the Main relay. |
| `task main:typecheck` | Type-check Main. |
| `task main:test` | Run Main unit tests. |
| `task model:typecheck` | Type-check the model package. |
| `task model:test` | Run model package tests. |

<!-- toolchain-inventory:end -->

## Agent orchestration

The [Goal program](../goals/README.md) owns the worker lifecycle and commands;
the [manager charter](../goals/manager.md#resources) owns engine selection and
usage limits. CLI versions are host installations, not product pins. Workers use
the checked-in `scripts/goal/goalctl.ts` and its tests.

### Agent browser

Agents drive a real browser through [BrowserOS](https://github.com/browseros-ai/BrowserOS),
a Chromium fork with a built-in MCP server; it replaced the Claude in Chrome
extension on 2026-09-28 (maintainer). The extension was hard to drive and
refuses some public reference sites, and headless Playwright trips those sites'
bot checks. Playwright stays for scripted tests, stories and repeatable
measurements.

- Host installation: v0.50.5 AppImage at `~/.local/opt/browseros/` (checksum
  verified against the GitHub release), launched by `browseros` or the desktop
  entry. It must be running for its MCP server to answer.
- MCP: `http://127.0.0.1:9200/mcp`, registered as `browseros` in every engine.
  The host keeps its shared MCP servers in one list, `~/.agents/mcp.json`, and
  `~/.agents/bin/mcp-sync` writes it through each engine's own configuration:
  Claude Code (user scope), Codex (`~/.codex` and `~/.codex-1`), Grok and
  Cursor. It touches only the servers it lists and leaves each engine's own
  servers alone; `mcp-sync --check` reports drift. New sessions load it; a
  running session needs a restart or `/mcp`.
- Ports: CDP 9100, MCP and agent server 9200, proxy 9002 and 9003, recorded in
  `~/.config/browser-os/.browseros/config.json`, clear of the shared ports
  above. BrowserOS binds 9002, 9003 and 9200 on every interface and answers MCP
  there without authentication, so firewalld rejects external inbound on those
  ports in the FedoraWorkstation zone; keep that rule on any machine that runs it.
- Every connected agent acts with the BrowserOS profile's sessions. Importing
  personal Chrome logins exposes them to all of those agents; prefer test
  accounts for local-stack checks.
