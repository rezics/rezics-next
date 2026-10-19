# Toolchain and root commands

This is the entry point for tools used by this checkout. The tables
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

Compose and native QA clusters initialize with PostgreSQL's built-in `C.UTF-8`
locale provider, so new physical fixtures share Unicode code-point ordering
without inheriting different host and container glibc versions. Existing retained
copies keep their original locale: restore rebuilds indexes before refreshing
changed collation versions, and records repairs on the disposable copy. See
[PostgreSQL locale providers](https://www.postgresql.org/docs/18/locale.html#LOCALE-PROVIDERS)
and [collation version repair](https://www.postgresql.org/docs/18/sql-altercollation.html).

The development host uses native Docker Engine 29.9 (`docker-ce`), context
`default`, through `/var/run/docker.sock` and replaces Docker
Desktop because the QEMU VM pinned up to 18 GiB of host RAM as shared memory
and imposed a 24 GiB container ceiling. Start the native engine with
`sudo systemctl start docker`. QA admission uses host MemAvailable and one
reserve on this engine; Docker Desktop retains its separate VM and host budgets.

Task is the command facade for developers and agents. Run `task --list`; pass
extra arguments after `--`. Yarn installs dependencies with `task install` or
`task toolchain:install`; it does not run application commands. The lockfile is
the source for transitive package versions. Root and workspace package manifests
use exact direct pins; Compose and Dockerfiles pin external images by digest.

Goal orchestration settings live in `.goalctl/`. The tracked
`settings.schema.json` defines the versioned format; tracked `settings.json`
overrides built-in defaults, and ignored `settings.user.json` overrides shared
values for this computer and operator. Each layer declares `"version": 1` and
is validated on load. `task goal -- config` shows effective values and their
sources. Codex account names, launchers or homes, dispatch weights and ordered
`pastAllowance` resource lists belong only in the user layer. Service tier, review
engine, confirmation interval, QA and gate counts, unit gate scope and shards,
and Telegram recipient are settings fields too. See
[Resources](../goals/manager.md#resources) for their names and semantics.
Legacy one-value configuration under `.temp/goal-orchestration/` migrates once
to the user layer with a diagnostic; runtime state stays in `.temp/`.
The locally built Fuseki image has a content-addressed tag derived by
`scripts/dev/fuseki-image.ts` and checked by `task gen:check`.

Windows backend preparation uses the operating system's `robocopy` with bounded
retries and sixteen copy threads. It accepts successful exit codes 0–7 and
rewrites workspace junctions into the frozen checkout, so later source edits
cannot alter the serving revision. This avoids GNU `cp` traversing Windows
junctions and copying dependencies beyond the preparation budget. Task enables
Python UTF-8 mode on every platform so generated documentation has one encoding.

`task jena:image` stamps and obtains that tag: an existing image returns immediately;
otherwise callers share a host-wide lock keyed by tag and inspect again before
building. Generation, stack startup, toolchain installation and dev refresh use
the same implementation. Linux `flock` (util-linux 2.41.5 on the development host)
holds the lock across its builder process and releases it when the descriptors
close; lock files under `/tmp/rezics-fuseki-images` must not be deleted while a
build is running. See the [flock manual](https://man7.org/linux/man-pages/man1/flock.1.html).

Windows uses a named kernel mutex around the same input checks, memory admission
and bounded image build. The builder owns the mutex until its command exits.

Frontend Task commands invoke the installed Node CLI entry points directly so
Windows does not interpret POSIX `.bin` shims as commands. Vinext forwards
`--host` to Vite; its retired `--hostname` option aborts startup. Storybook uses
`--ci` to suppress prompts and browser opening; version 11 removed `--no-open`.

The module packages with `-DskipTests`; `task jena:test` builds the separate
`module-test` target with the original Maven options and locked fixture cache.
The affected merge gate selects this native proof for every `infra/jena/**`
change and module COPY input, including generated model files; wave regression
runs it once per pinned tip. ExternalFixture cases retain their focused wrappers.
[BuildKit](https://docs.docker.com/build/building/multi-stage/#differences-between-legacy-builder-and-buildkit)
skips the test stage when building the runtime image. Jena downloads try
`dlcdn.apache.org` before `archive.apache.org` and always verify the pinned SHA-512.
This split removes the 16–40 minute native suite and slow archive download from
ordinary image preparation without weakening the gate; simultaneous image
builds previously repeated the suite while waiting on its fixture cache lock.
Type checks run `bun check`, Bun's built-in checker (the same errors as `tsc` from
TypeScript 7, in seconds instead of minutes), so the host needs Bun 1.4.3 or newer and
`task <workspace>:typecheck` refuses an older one. `tsc` stays installed for the Eden gate
and for emit.

Release application containers use Bun 1.4.3 from
`oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598`.
The index digest was inspected with `task release:images -- --inspect-base`;
`scripts/dev/release-manifest.ts` owns this pin. The build uses the installed
Yarn 4.18.0 CLI to focus production dependencies in its builder stage.

When adding or replacing a tool, update its owning manifest/configuration, the
lockfile or image digest where applicable, and the reason and verification in
the owning change. Regenerate this page with
`python3 scripts/documentation/toolchain_inventory.py --write`; `task docs:check`
rejects a stale table. For native install scripts, inspect the script and add
only the required package to `dependenciesMeta.<name>.built`; Yarn's global
`enableScripts` remains disabled. The repository uses a private TypeScript 6
parser for dependency-cruiser through `.yarnrc.yml`; product typechecks use the
TypeScript version in their manifests.

The October 2026 dependency refresh follows each existing release channel:
stable dependencies follow `latest`, while Elysia and Storybook retain their
beta and alpha lines. The maintainer authorized current releases, including
ones younger than Yarn's one-day quarantine; the refresh used the command-local
`YARN_NPM_MINIMAL_AGE_GATE=0` override without changing the install policy.

Elysia beta.32 uses `onRequest`, `onStart`, `onStop`, `onBeforeHandle`,
`onAfterResponse` and `onError`. Global admission refusals use typed `status`
wrappers so Eden does not infer them as successful responses. The beta.2
OpenTelemetry package still needs our socket/status patch. Generation after
this group produced an identical Main OpenAPI contract, and the Eden consumer,
OpenAPI, telemetry socket and private-delivery lifecycle checks passed.
Native response validators require the Problem body directly inside a typed
status result; global rate-limit and backpressure refusals preserve their
status, media type and retry headers through that path. The address-miss
response mapper serializes the same refusal at the final mapping boundary.
Closed 429 response schemas also admit the existing optional budget `family`
field: beta.32 validates typed admission replies against those schemas, so
omitting the field from the schema turned upload refusals into validation errors.

The inference baseline was recorded again with three fresh samples after the
compiler environment changed and wave/2 merged. Relative to main’s previous
baseline, Main, web and Eden instantiations rose by 8.2%, 9.1% and 6.2%; rendered
route types shrank by 14.2%. Median checks were 20.588 s, 33.873 s and 13.175 s
on the shared host. The recorded source revision includes the merged wave/2 tree.
The baseline retains the existing 5% graph/display margin, timing margin and
independent 30-second Eden wall limit. This records the cost of the new
dependency cohort so future application changes are measured against it.

Playwright, `@playwright/test` and the transitive `playwright-core` remain at
main's 1.63.0 with its matching browser revision. Settlement observed different
transport-loss behavior under 1.64.1 in the real-module forwarding and asset
connection-reset tests in `scripts/qa/story-browser.test.ts`; the program held
this browser cohort for separate investigation. Storybook 11 alpha.6, Vitest
5.0.4 and its browser adapter remain upgraded; the adapter uses the installed
Playwright rather than bundling another browser.
Web story tests now use reduced motion, as Accounts already
does, so automatic accessibility checks observe settled controls rather than
an enabling opacity transition. Storybook asset forwarding retries only connection
resets on idempotent asset GETs; HTTP errors, application API calls and stories
are not retried. A real TCP-reset test covers that boundary. Browser journeys
retain main’s loopback Chromium interface-change protection, route disposables
and callback draining instead of intercepting assets; API commands are never replayed.
The session lifecycle and bilingual Work-creation journeys allow 90 seconds
for their multiple hydrated navigations; their existing assertions remain.

The `typescript-6` alias and dependency-cruiser's private parser use 6.0.3,
the newest TypeScript release with the JavaScript compiler API. TypeScript
7.0.2 lacks `createSourceFile`, which our AST consumers need; the native
product typechecker remains on 7.0.2.

markdown-it 15 closes internal subpath exports and supplies its own types.
The document adapter obtains its blockquote rule through the public parser API;
the old private-module declaration and redundant DefinitelyTyped dependency are
removed. Better Auth's Nanostores peer is deduplicated with the direct pin so
its core types and plugin augmentations resolve to one instance. The OTLP test
decoder models scalar values as the protocol's `oneof`, preserving explicit
zero values under protobufjs 8.

The newer accessibility run also exposed disabled radio labels being dimmed
with their controls. Only the indicator now dims, preserving readable labels
and help text while interaction remains disabled. The shared radio stories and
the recorded Realm-creation and Zone-theme flows cover the correction.

`@elysia/openapi` beta.6 still replaces authored `detail.responses` when a route
also has a response schema: a focused probe lost its authored description and
content schema. Keep the response overlay when rebasing onto the wave/2 tree;
this refresh's starting tree did not contain it. The dependency groups preserved
the existing generated Main contract; native pilot invariant checks also pass.

`task dev` starts the shared local stack through Aspire in the main checkout.
In a worktree it starts the Accounts app, web app and Storybook on allocated
ports against the shared backend; `task dev -- --backend` creates an isolated
backend. Use `task urls` for addresses. The Accounts app is the public Account
origin. `task env` masks local secrets;
workspace `.env.example` files show variables. Personal overrides belong in
the ignored root `.env.dev`, not `.env` or `.env.local`, which Bun can load into
unrelated processes.

## Shared repository parser

The repository guards share the native `tools/repo-index` package, built with
Rust/Cargo 1.98.1 by `task repo-index:build`. Oxc parses TypeScript and TSX and
resolves imports ([parser](https://docs.rs/oxc_parser/0.152.0/oxc_parser/),
[resolver](https://docs.rs/oxc_resolver/11.24.3/oxc_resolver/));
[`pg_query`](https://docs.rs/pg_query/6.2.0/pg_query/) embeds
[`libpg_query`](https://github.com/pganalyze/libpg_query)'s PostgreSQL parser and scanner for SQL
facts. Guard policy, messages and debt lists remain in TypeScript. The reader
builds a missing or changed binary before use; its content digest reuses an
unchanged JSON index under `.temp/`. `Cargo.lock` pins transitive crates.
The index is one JSON file with a small header and byte ranges for independently
read payloads. ASTs and SQL facts use compressed JSON strings so each guard
materializes only the syntax trees and query facts it inspects.
The pinned `oxc_estree` serializer preserves JavaScript string escapes while
writing compact initializer syntax; opaque expressions retain their original
kind and source range for the TypeScript rules to read.
[`sha2`](https://docs.rs/sha2/0.10.9/sha2/) provides per-file SHA-256 content keys
that let the reader register source identities without loading source payloads.
Task and the guard reader resolve the same executable through
`scripts/lib/repo-index.ts`. Cargo's crate cache is shared at
`~/.cache/rezics/repo-index/cargo`, isolated from `~/.cargo`. Successful binaries
live at `~/.cache/rezics/repo-index/<key>/repo-index`; the SHA-256 key includes
all paths and bytes under `tools/repo-index/` (including `Cargo.lock`), the exact
Cargo version, OS and architecture. A kernel `flock` allows one build per key,
rechecks inputs before publication and releases on process exit. Matching
worktrees reuse the executable without downloading or compiling. Build output
is temporary under the shared cache; parsed JSON indexes stay worktree-local.
`REZICS_REPO_INDEX_CACHE` overrides the shared root for isolated verification.
Native Rust tests keep their target output in `.temp/repo-index-test`.
Building needs a C compiler and libclang development headers for `pg_query`'s
bindings. The Task command supplies the C compiler's system include directory
when `BINDGEN_EXTRA_CLANG_ARGS` is unset.

## Turtle model compilation

The model compiler uses [N3.js](https://github.com/rdfjs/N3.js) (MIT) to parse
Turtle into RDF terms. Its bounded converter accepts only the SHACL constructs
needed by the Post and Work-reference payload; unsupported constructs fail
generation by name. This preserves literal versus IRI meaning without maintaining
a Turtle parser. The exact `n3` and `@types/n3` pins are in the inventory below;
[converter tests](../../model/compiler/shacl.test.ts) cover the supported subset
and rejection boundary against [SHACL](https://www.w3.org/TR/shacl/).

## Offline wiki conversion

`@rezics/wiki-toolkit` distributes TypeScript source and requires Bun 1.4.2+,
including for installed CLI execution. Node's source stripping does not run
TypeScript packages inside `node_modules`. The package adds iconv-lite for
reversible legacy decoding, fflate for ZIP reading and @xmldom/xmldom for inert
XML parsing; these and its existing typebox protocol dependency use MIT licences.
TypeScript 7 checks source types, and the TypeScript 6 alias supplies the test AST
API (both Apache-2.0); @types/node and undici-types use MIT. Exact pins are in the
inventory below and dependency notices in the package's NOTICE. Runtime source
imports and the installed package are checked for the offline boundary; no
network, inference or REZICS service implementation enters the package.

Main pins the same @xmldom/xmldom version for readers' uploaded MyAnimeList and
VNDB exports. Both adapters reject entity declarations and enforce file-byte,
list-entry and XML-depth budgets before retaining source fields; they perform
no live tool pulls.

## Local image classification

Main pins NSFWJS 4.4.0 (MIT), TensorFlow.js 4.22.0 (Apache-2.0), Buffer 6.0.3
(MIT) and sharp 0.35.5 (Apache-2.0). Web reuses the same NSFWJS, TensorFlow.js and
Buffer pins for upload-time browser classification. NSFWJS's bundled MobileNetV2 weights (MIT) keep
inference local without a hosted model or native TensorFlow build. Browser
classification is loaded on demand and records versioned NSFW display evidence;
it does not determine byte-delivery permission. The retained server worker is
available for historical review and a later producer migration. sharp uses
its prebuilt libvips adapter for the admitted raster formats; its redistributed
libvips is [LGPL-3.0-or-later](https://github.com/lovell/sharp-libvips/blob/main/npm/linux-x64/package.json). The smoke test
[`g-571-screen.test.ts`](../../services/main/tests/g-571-screen.test.ts) loads
and hashes the real weights, decodes a generated PNG and runs the CPU backend
under Bun. No native install script is enabled.

The [NSFWJS model-loading contract](https://github.com/infinitered/nsfwjs/tree/v4.4.0)
supports bundled model definitions and tensor input. sharp's
[constructor bounds](https://sharp.pixelplumbing.com/api-constructor/) and
[processing timeout](https://sharp.pixelplumbing.com/api-operation/#timeout)
supply decode limits. REZICS additionally bounds bytes, pixels and frames and
runs decoding and inference in a child process, killed with SIGKILL at its deadline.
The [Bun subprocess contract](https://bun.sh/docs/runtime/child-process) supplies
process exit and termination; a native decoder crash cannot crash Main. These
checks establish runtime compatibility and failure handling; they do not measure classifier
accuracy on REZICS uploads. Thresholds and the weights digest live in
[`policy.ts`](../../services/main/src/modules/media-screen/policy.ts).

## Chinese script and kana search folding

The command jar bundles `lucene-analysis-icu` 10.3.1 (Apache-2.0), matching
[Jena 6.2.0's Lucene pin](https://github.com/apache/jena/blob/jena-6.2.0/pom.xml),
and its ICU4J 77.1 dependency (Unicode licence). Maven Shade 3.6.1 packages these
two dependencies and their resources; Lucene core/common remain Jena's bundled
copies. The same jar serves Fuseki and the offline indexer, including erasure
rebuilds. The module tests and disposable integration fixtures qualify matching,
original literals/languages and generation readiness.

`CjkBigramV2` applies
[ICU NFKC case/width normalization](https://github.com/apache/lucene/blob/releases/lucene/10.3.1/lucene/analysis/icu/src/java/org/apache/lucene/analysis/icu/ICUNormalizer2CharFilter.java)
before tokenization, then
[Traditional-to-Simplified and hiragana-to-katakana transforms](https://github.com/apache/lucene/blob/releases/lucene/10.3.1/lucene/analysis/icu/src/java/org/apache/lucene/analysis/icu/ICUTransformFilter.java)
before CJK bigrams. Folding is many-to-one: original spellings stay stored for
display, while voiced/unvoiced and small/large kana remain distinct. Dataset
profile `search-index-cjk-bigram-v3` advances the prior v2 title-field profile.
Run `task search:rebuild` with writers stopped to upgrade an existing volume;
its quarantined profile step replaces the probe before rebuilding an empty
index. Activation and requests require the Chinese, kana and width witnesses.

## Fuseki integer-preservation patch

Jena 6.2.0's TDB2 node table (`NodeTableTRDF`) always writes through
[`ThriftConvert.toThriftValue`](https://github.com/apache/jena/blob/jena-6.2.0/jena-arq/src/main/java/org/apache/jena/riot/thrift/ThriftConvert.java),
which stored every `xsd:integer`, `long`, `int`, `short` and `byte` literal that
TDB2 does not inline as `BigInteger.longValue()`. An integer outside signed 64
bits was silently wrapped (`1111…` with 120 digits read back as
`8198552921648689607`), and `xsd:long` values from 2^55 and padded lexical forms
such as `+0000000000000000000012` came back as canonical `xsd:integer`. Neither
the node table nor `ValInteger` writing is configurable, and 6.2.0 is the
current release with the same code on `main`.

[`infra/jena/patches/ThriftConvert.java`](../../infra/jena/patches/ThriftConvert.java)
is the upstream 6.2.0 source with one change: only plain `xsd:integer` whose
value is a signed 64-bit number printed exactly as its lexical form is written
as `ValInteger`; everything else takes the existing literal path with its own
datatype and lexical form. The decoder is untouched, so stores written earlier
stay readable. The Fuseki Dockerfile checks the shaded class against a pinned
SHA-256 (equal to the class in `jena-arq-6.2.0.jar`), compiles the patch with
`--release 21` against `fuseki-server.jar` and replaces the class there; a class
under `extra/*` cannot shadow it because `fuseki-server.jar` precedes `extra/*`.
[`native-integer-preservation.test.ts`](../../infra/jena/tests/native-integer-preservation.test.ts)
writes TDB2 files in one JVM and reads them in another, with the pinned upstream
class (the old behaviour) and the image's jar.

Terms already truncated cannot be repaired from the store: the original value is
gone, and adding the same term again finds the existing node-table entry. They
need a rebuild from the source of truth through the API. Values TDB2 inlines
(under 2^55 and at most 19 characters) keep TDB2's documented canonical form.
Remove the patch, the Dockerfile step and the test when a Jena release stops
wrapping out-of-range integers in `toThriftValue` and keeps derived datatypes.

## Pinned Jena CLI

`task jena:check` runs the already built Fuseki image from Compose. It does not
build or pull that image and it does not start the shared stack. Host Java is
still unnecessary. The command validates authored Turtle under
`model/definitions`, generated shapes under `generated/model/shapes`, and the
four Fuseki assemblers in `infra/jena` with `riotcmd.riot --validate`. It parses
the reviewed [work-versions query](../../services/main/src/modules/query/templates/work-versions.rq)
through the same offline `arq.qparse --explain` capture as
[fuseki-plan.ts](../../scripts/load/fuseki-plan.ts), and RIOT-checks the TriG
dataset in that query's
[fixed fixture](../../services/main/src/modules/query/templates/work-versions.fixture.json).
It then loads only [scratch.trig](../../tests/fixtures/jena-cli/scratch.trig)
with `tdb2.tdbloader --loader=basic` into container-local `/tdb` and runs
`tdb2.tdbstats` twice, once for the default graph and once for
`https://rezics.com/jena-cli/scratch`. Stats stay on stdout under `.temp/jena-cli`.
The check does not install `stats.opt`, does not measure a live store, and does
not prove physical boundedness.
[Jena command-line tools](https://jena.apache.org/documentation/tools/) and the
[TDB2 commands](https://jena.apache.org/documentation/tdb2/tdb2_cmds.html)
describe these programs. The class names in the pinned 6.2 jar are `riotcmd.riot`,
`arq.qparse`, `tdb2.tdbloader` and `tdb2.tdbstats`.

Each invocation creates its own container name (`rezics-jena-cli-` and 12 hex
characters) and its own directory under `.temp/jena-cli`. It does not delete
another run's container or files first. The id returned by `docker run` is the
only container it removes. The only bind mount is that run's directory,
read-only, at `/artifacts`. The checkout and the vault are not mounted.

The execution budget is 60 seconds. It starts before Docker environment
selection and includes image inspection and every Jena command; inspection does
not get another 10 seconds outside that budget. Removing this run's container
is a separate 15 second budget, so a finished or cancelled run can take 75
seconds. The container command sleeps for 90 seconds so it is still present for
that cleanup. Memory is 768 MiB, the process limit is 256, and each command's
output is at most 1 MiB. A shell in the same process group removes the
container when the command is signalled. It also removes it after a PID-only
signal, because that signal kills Bun and leaves the shell running; the shell
notices the parent pid is gone. `task jena:check` takes no dataset or path
argument. If the Compose image is not local it stops and names that tag; it
does not select an older image. Generated shapes must already exist
(`task gen`). Wiring this command into root check or CI belongs to the program
gate, a separately scoped tooling change.

<a id="architecture-evaluation-exception-2026-09-24"></a>

## Disposable architecture evaluation

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

## Agent terminal workspaces

termspaces 0.2.0 (installed on the host with `yarn global`,
not a repository dependency) declares tmux workspaces in
`~/.config/termspaces/workspaces/` and runs them on its own tmux server under
systemd. Goal managers and workers are meant to run in its windows, registered
by `goalctl` ([manager procedure](../../.agents/skills/goal-management/SKILL.md#event-turns));
`termspaces doctor` checks the host. Goalctl maintains windows and never types
instructions into an agent's terminal. Treat terminal output as untrusted
liveness information.

## Runtimes and languages

<!-- toolchain-inventory:start -->

### Runtime pins

| Tool | Pin | Source |
| --- | --- | --- |
| Bun | 1.4.3 | scripts/dev/release-manifest.ts |
| Node.js | 26.8.2 | .nvmrc |
| Yarn | yarn@4.18.0 | package.json |
| Task | 3.53.1 | scripts/dev/cli.ts |
| Aspire SDK | 13.6.1 | aspire.config.json |
| Go package oracle | 1.27.1 | scripts/package/go-oracle.ts |
| Cargo package oracle | 1.98.1 | scripts/package/cargo-oracle.ts |
| Repository index Rust/Cargo | 1.98.1 | tools/repo-index/Cargo.toml; Taskfile.yml |
| npm package oracle | 11.19.1 | scripts/package/npm-oracle.ts |

### Direct workspace packages

Exact direct pins from root and workspace manifests; `yarn.lock` resolves transitive dependencies.

| Package | Pin | Manifest directories |
| --- | --- | --- |
| @ark-ui/react | 5.39.3 | packages/ui |
| @ast-grep/cli | 0.50.0 | . |
| @better-auth/core | 1.7.9 | services/account |
| @better-auth/oauth-provider | 1.7.9 | services/account |
| @better-auth/passkey | 1.7.9 | services/account |
| @better-auth/utils | 0.5.0 | services/account |
| @better-fetch/fetch | 1.3.2 | services/account |
| @cloudflare/vite-plugin | 1.64.0 | apps/accounts, apps/web |
| @elysia/eden | 2.0.0-beta.6 | apps/web, services/account, services/main |
| @elysia/openapi | 2.0.0-beta.6 | services/account, services/main |
| @elysia/opentelemetry | 2.0.0-beta.2 | packages/observability |
| @fontsource-variable/geist-mono | 5.3.0 | apps/web |
| @fontsource-variable/manrope | 5.3.0 | apps/accounts, apps/web |
| @fontsource-variable/source-serif-4 | 5.3.1 | apps/web |
| @js-temporal/polyfill | 0.5.1 | services/main |
| @microsoft/aspire-cli | 13.6.1 | apphost |
| @modelcontextprotocol/client | 2.3.1 | services/main |
| @modelcontextprotocol/server | 2.3.1 | services/main |
| @opentelemetry/api | 1.9.1 | packages/observability |
| @opentelemetry/api-logs | 0.223.0 | packages/observability |
| @opentelemetry/core | 2.12.0 | packages/observability |
| @opentelemetry/exporter-logs-otlp-proto | 0.223.0 | packages/observability |
| @opentelemetry/exporter-metrics-otlp-proto | 0.223.0 | packages/observability |
| @opentelemetry/exporter-trace-otlp-proto | 0.223.0 | packages/observability |
| @opentelemetry/instrumentation-pg | 0.75.0 | packages/observability |
| @opentelemetry/resources | 2.12.0 | packages/observability |
| @opentelemetry/sdk-logs | 0.223.0 | packages/observability |
| @opentelemetry/sdk-metrics | 2.12.0 | packages/observability |
| @opentelemetry/sdk-node | 0.223.0 | packages/observability |
| @opentelemetry/sdk-trace-base | 2.12.0 | packages/observability |
| @playwright/test | 1.63.0 | . |
| @rezics/account | workspace:* | apps/accounts |
| @rezics/document | workspace:* | apps/web, packages/ui, services/content, services/main |
| @rezics/main | workspace:* | apps/web |
| @rezics/observability | workspace:* | services/account, services/main |
| @rezics/ui | workspace:* | apps/accounts, apps/web |
| @rezics/wiki-toolkit | workspace:* | packages/model, services/main |
| @rezics/zone-sdk | workspace:* | apps/web |
| @scalar/types | 0.23.2 | services/account, services/main |
| @storybook/addon-a11y | 11.0.0-alpha.6 | apps/accounts, apps/web |
| @storybook/addon-mcp | 11.0.0-alpha.6 | apps/web |
| @storybook/addon-vitest | 11.0.0-alpha.6 | apps/accounts, apps/web |
| @storybook/react-vite | 11.0.0-alpha.6 | apps/accounts, apps/web |
| @tailwindcss/vite | 4.3.3 | apps/accounts, apps/web |
| @tanstack/react-query | 5.104.3 | apps/web |
| @tensorflow/tfjs | 4.22.0 | apps/web, services/main |
| @tiptap/core | 3.32.0 | packages/ui |
| @tiptap/extension-bubble-menu | 3.32.0 | packages/ui |
| @tiptap/extension-image | 3.32.0 | packages/ui |
| @tiptap/extension-list | 3.32.0 | packages/ui |
| @tiptap/extension-placeholder | 3.32.0 | packages/ui |
| @tiptap/extension-table | 3.32.0 | packages/ui |
| @tiptap/extension-text-align | 3.32.0 | packages/ui |
| @tiptap/extension-text-style | 3.32.0 | packages/ui |
| @tiptap/extension-unique-id | 3.32.0 | packages/ui |
| @tiptap/extensions | 3.32.0 | packages/ui |
| @tiptap/pm | 3.32.0 | packages/ui |
| @tiptap/react | 3.32.0 | packages/ui |
| @tiptap/starter-kit | 3.32.0 | packages/ui |
| @tiptap/suggestion | 3.32.0 | packages/ui |
| @types/bun | 1.4.3 | apps/accounts, packages/document, packages/model, packages/observability, services/account, services/content, services/main |
| @types/n3 | 1.26.4 | . |
| @types/node | 26.6.5 | apphost, apps/accounts, apps/web, packages/wiki-toolkit |
| @types/nodemailer | 8.0.2 | services/account |
| @types/pg | 8.23.1 | packages/observability, services/account, services/content, services/main |
| @types/react | 19.3.0 | apps/accounts, apps/web, packages/ui, packages/zone-sdk |
| @types/react-dom | 19.3.0 | apps/accounts, apps/web, packages/ui |
| @vinext/cloudflare | 1.0.0-beta.11 | apps/web |
| @vitejs/plugin-react | 6.1.2 | apps/accounts, apps/web |
| @vitejs/plugin-rsc | 0.5.38 | apps/accounts, apps/web |
| @vitest/browser-playwright | 5.0.4 | apps/accounts, apps/web |
| @xmldom/xmldom | 0.9.12 | packages/wiki-toolkit, services/main |
| aws4fetch | 1.0.20 | services/main |
| axe-core | 4.14.0 | apps/web |
| better-auth | 1.7.9 | services/account, services/main |
| better-call | 1.4.2 | services/account |
| buffer | 6.0.3 | apps/web, services/main |
| dependency-cruiser | 18.6.0 | . |
| drizzle-orm | 0.45.4 | services/content |
| elysia | 2.0.0-beta.32 | apps/web, packages/observability, services/account, services/main |
| envalid | 8.2.0 | apps/accounts, apps/web, packages/observability, services/account, services/main |
| exact-mirror | 1.2.6 | packages/observability, services/account, services/main |
| fast-check | 4.10.2 | packages/model |
| fflate | 0.8.3 | ., packages/wiki-toolkit |
| iconv-lite | 0.7.3 | packages/wiki-toolkit |
| jose | 6.2.12 | services/account, services/main |
| knip | 6.41.0 | . |
| kysely | 0.29.6 | services/account |
| lucide-react | 1.57.0 | apps/accounts, apps/web, packages/ui |
| markdown-it | 15.0.2 | packages/document |
| n3 | 2.13.12 | . |
| nanostores | 1.5.5 | services/account |
| native-i18n | 0.2.0 | apps/accounts, apps/web |
| next | 16.4.1 | apps/accounts, apps/web |
| nodemailer | 10.1.1 | services/account |
| nsfwjs | 4.4.0 | apps/web, services/main |
| nuqs | 2.10.2 | apps/web |
| openapi-types | 12.1.3 | packages/observability, services/account, services/main |
| oxfmt | 0.73.0 | . |
| oxlint | 1.88.0 | . |
| oxlint-tsgolint | 7.0.2004 | . |
| pg | 8.23.1 | packages/observability, services/account, services/content, services/main |
| playwright | 1.63.0 | apps/accounts, apps/web |
| prosemirror-markdown | 1.13.8 | packages/document |
| prosemirror-model | 1.25.12 | packages/document |
| prosemirror-schema-basic | 1.2.5 | packages/document |
| prosemirror-schema-list | 1.5.1 | packages/document |
| prosemirror-tables | 1.8.5 | packages/document |
| protobufjs | 8.8.1 | packages/observability |
| react | 19.3.1 | apps/accounts, apps/web, packages/ui, packages/zone-sdk |
| react-dom | 19.3.1 | apps/accounts, apps/web, packages/ui |
| react-is | 19.3.1 | packages/ui |
| react-server-dom-webpack | 19.3.1 | apps/accounts, apps/web |
| recharts | 3.10.1 | packages/ui |
| sharp | 0.35.5 | services/main |
| storybook | 11.0.0-alpha.6 | apps/accounts, apps/web |
| tailwind-variants | 3.3.1 | packages/ui |
| tailwindcss | 4.3.3 | apps/accounts, apps/web |
| tsx | 4.23.15 | apphost |
| tw-animate-css | 1.4.0 | packages/ui |
| typebox | 1.3.37 | packages/document, packages/model, packages/observability, packages/wiki-toolkit, services/account, services/main |
| typescript | 7.0.2 | apphost, apps/accounts, apps/web, packages/document, packages/model, packages/observability, packages/ui, packages/wiki-toolkit, packages/zone-sdk, services/account, services/content, services/main |
| typescript-6 | npm:typescript@6.0.3 | packages/wiki-toolkit |
| vinext | 1.0.0-beta.13 | apps/accounts, apps/web |
| vite | 8.3.4 | apps/accounts, apps/web |
| vitest | 5.0.4 | apps/accounts, apps/web |
| vscode-jsonrpc | 8.2.0 | apphost |
| webpack | 5.111.1 | apps/accounts, apps/web |
| wrangler | 4.151.0 | apps/accounts, apps/web |

### Repository index crates

Exact direct pins from `tools/repo-index/Cargo.toml`; its Cargo.lock records the native parser dependencies.

| Crate | Pin |
| --- | --- |
| base64 | 0.22.1 |
| blake3 | 1.8.3 |
| flate2 | 1.1.5 |
| oxc_allocator | 0.152.0 |
| oxc_ast | 0.152.0 |
| oxc_ast_visit | 0.152.0 |
| oxc_estree | 0.152.0 |
| oxc_parser | 0.152.0 |
| oxc_resolver | 11.24.3 |
| oxc_span | 0.152.0 |
| pg_query | 6.2.0 |
| serde | 1.0.228 |
| serde_json | 1.0.149 |
| sha2 | 0.10.9 |

### Service and Fuseki build images

| Source | Image and digest |
| --- | --- |
| Compose | postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 |
| Compose | rezics/fuseki:6.2.0-cmd0.5.43-0f459f70f41e |
| Compose | rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff |
| Compose | ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e |
| Compose | axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d |
| Fuseki build | maven:3.9.16-eclipse-temurin-21@sha256:c2a2c58516d160f43b50f12baa427ca86989e0bc942609e04aff61da5d9a7d74 |
| Fuseki build | module |
| Fuseki build | eclipse-temurin:21.0.12_8-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f |
| Observability | oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 |
| Observability | greptime/greptimedb:v1.2.1@sha256:9982e36cf3ddb6f2bc813f93ec164509dce59e8c0667c6c38b826f293ec09477 |
| Observability | otel/opentelemetry-collector-contrib:0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1 |
| Observability | persesdev/perses:v0.54.0@sha256:a0e34ddaf9d7599d96036611af205b948c1179646844202d869f3bcf3d5d9e9c |

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
| `task statement:convert` | Convert retained classifications and rebuild Statement seek coverage on a fenced populated stack. |
| `task default` | List the available commands. |
| `task install` | Install the pinned workspace dependencies from the lockfile. |
| `task toolchain:bun-check` | Refuse a Bun older than 1.4.3, which has no built-in type checker. |
| `task toolchain:install` | From a clean clone, install dependencies, check runtimes, pull images, build Fuseki and install Chromium. |
| `task dev` | Start the dev environment under Aspire. Main checkout: shared backend and frontend on ports 3002 (Account), 3001 (Main), 3004 (Accounts app), 3000 (web), 6006 (Storybook). Worktree: Accounts app, web and Storybook on random ports against it, or -- --backend for its own isolated stack. |
| `task dev:stop` | Stop this checkout's AppHost; a worktree backend also removes its isolated stack. |
| `task dev:reset` | Print and, with -- --yes, recreate only this checkout's dev stack data. |
| `task urls` | Show this checkout's running resources with their URLs and health. |
| `task env` | Show the application environment this checkout uses, secrets masked, and where it comes from. |
| `task env:example` | Regenerate each workspace's .env.example from its envalid config specs. |
| `task zones:digest` | Compute the digest of an installed official Zone source package. |
| `task dev:prepare` | Start storage, apply migrations and write the application environment without starting processes. |
| `task dev:refresh` | Bring the shared dev stack to committed main, preserving data; use -- --dry-run to inspect the plan, -- --wait to queue for shared lifecycle. |
| `task dev:seed` | Seed this checkout's local demo through its public APIs. |
| `task scripts:typecheck` | Type-check every script except the dataset tools. |
| `task apphost:typecheck` | Type-check the AppHost and its configuration imports with Node types. |
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
| `task goal:type-files` | Type-check selected files and their imports with host admission. |
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
| `task document:typecheck` | Type-check the independent document protocol. |
| `task document:gen` | Generate the standalone Document Core, Text and Blocks JSON Schemas. |
| `task goal` | Run goalctl from the repository root. Sets GOAL_MAX_WORKERS to the program's live-worker cap and STORYBOOK_MAX_WORKERS to 2 when they are unset. |
| `task goal:unit-files` | Run the explicit Bun unit and inventory files selected by the merge gate. |
| `task guards` | Run the repository-wide inventory guards the merge gate enforces (scripts/qa/repository-guards.ts). No stack; about three minutes. |
| `task observability:typecheck` | Type-check the shared telemetry runtime. |
| `task observability:aspire-smoke` | Verify real server spans, structured logs and OTLP authentication against the running backend AppHost. |
| `task observability:check` | Validate the pinned observability Compose and Collector configurations with disposable local secrets. |
| `task observability:smoke` | Exercise OTLP ingestion and Perses provisioning on an isolated disposable local observability stack. |
| `task check` | Run every static gate (types, generated contracts, docs, lint, format, code shape, catalogs, unused files, imports). |
| `task check:backend` | Run the static gates without UI and web sources. |
| `task check:unused` | Report unused files, dependencies and exports with Knip. |
| `task ast-grep` | Run the pinned ast-grep binary (scan or test) with sgconfig.yml. |
| `task docs:check` | Check documentation links, fragments and navigation. |
| `task i18n:check` | Fail when a web, Accounts, official Zone or UI catalog has a missing, extra, empty or placeholder-mismatched key. |
| `task test` | Run explicit test files or the affected plan (-- --affected [<base>] [--list]). |
| `task qa` | Run the QA harness tiers (-- --backend, --tier, --record, ...). |
| `task qa:replay` | Replay one property or model test with a logged seed. |
| `task api:fuzz` | Run Schemathesis against Main's generated OpenAPI contract on an isolated stack. |
| `task gen` | Regenerate model, OpenAPI and pinned-image artifacts and the toolchain inventory. |
| `task gen:check` | Fail if generated artifacts are stale. |
| `task repo-index:build` | Build the shared Rust repository parser with pinned Cargo 1.98.1. |
| `task repo-index:lock` | Resolve and lock the exact direct Rust repository-index dependency pins. |
| `task repo-index:format` | Format the shared Rust repository-index package. |
| `task repo-index:test` | Test Rust source parsing, SQL facts and content-index invalidation. |
| `task repo-index:run` | Parse repository sources once or reuse their content-digest index. |
| `task operation` | Find Main API operation declarations, handlers and calling tests. |
| `task jena:check` | Validate Turtle and assemblers, parse one reviewed query, and record scratch TDB2 statistics with the pinned Jena CLI. |
| `task jena:image` | Obtain the input-pinned Fuseki image, building once per tag under a host-wide lock. |
| `task jena:test` | Run the native Maven suite (or -- --tests Class[#method][,Class...]) in the module-test Docker target. |
| `task toolchain:inventory` | Regenerate the toolchain inventory from manifests and root commands. |
| `task dataset:fetch` | Explicitly capture complete real-world series into the external local dataset store. |
| `task dataset:verify` | Verify an external dataset snapshot and all referenced local bytes without network access. |
| `task dataset:import` | Import a captured dataset through existing public APIs and write the Markdown URL index. |
| `task dataset:bootstrap-admin` | Create and authorize the dedicated local dataset administrator without resetting existing data. |
| `task dataset:bootstrap-model` | Align the local fixture model generation with the current build while preserving all prior data and revisions. |
| `task dataset:test` | Run the opt-in offline real-dataset conformance suite. |
| `task dataset:typecheck` | Type-check the independent local dataset tools. |
| `task dataset:check` | Check the dataset tools types, lint and formatting without capturing or importing data. |
| `task dataset:format` | Format the local dataset tools and their unit tests. |
| `task fixture:build` | Build a deterministic background corpus into owner storage. |
| `task fixture:restore` | Restore a fixture backup into a new persistent QA stack. |
| `task fixture:prune` | List fixture generations and abandoned volumes a current restore cannot use. Pass --apply to remove them. |
| `task fixtures:pull` | Replay verified factual fixtures from the cache or committed seed. |
| `task load` | Run the mixed host load profile. |
| `task load:prepare` | Build a reusable command-created load baseline. |
| `task load:clone-probe` | Probe a cloned load stack for isolation and fresh commands. |
| `task launch:corpus` | Build the retained launch API corpus or prepare a launch browser corpus. |
| `task release:build` | Package a content-addressed local release artifact. |
| `task release:images` | Build local pinned OCI runtime images and record their release manifest; never push. |
| `task ops:migrate` | Apply the release's locked, idempotent owner migrations. |
| `task ops:env-check` | Validate production configuration, refuse payment provider rows and state the governance opening gate. |
| `task ops:postgres-preflight` | Verify production owner diagnostic grants and disabled prepared transactions without writes. |
| `task ops:mail-check` | Read bounded SPF, DKIM and DMARC DNS evidence without sending mail. |
| `task ops:platform-governance` | Refuse production opening without an active permanent platform grant holder; warn until two hold it. |
| `task ops:bootstrap` | Provision launch Realms, Zones and vocabulary, then admit bounded catalogue records through public APIs. |
| `task release:install` | Verify a release artifact and provision a project from it. |
| `task search:rebuild` | Rebuild the public search index on a stopped-writer stack. |
| `task search:names:backfill` | Resume public names, browse directories and rating counters online. |
| `task access:pending-search` | List unresolved private search deliveries (needs ACCESS_DATABASE_URL). |
| `task rating:reconstruct` | Resume bounded legacy target-rating reconstruction with a local checkpoint. |
| `task structure:prepare-groups` | Prepare exact retained Structure group roots from a held owner cut. |
| `task research:architecture` | Run the storage architecture research lab. |
| `task package:go-oracle` | Compare Go module resolution with the pinned native Go. |
| `task package:go-probe` | Run the Go provider probe. |
| `task package:go-checksum-oracle` | Compare Go checksum provenance with the pinned native Go. |
| `task package:cargo-oracle` | Compare Cargo resolution with the pinned native Cargo. |
| `task package:npm-oracle` | Compare npm lockfile topology with the pinned native npm. |
| `task account:dev` | Run Account in watch mode. |
| `task account:test` | Run Account unit tests. |
| `task account:typecheck` | Type-check Account. |
| `task account:mail-report` | Report uncertain Account mail and optional-mail suppression counts; never resend. |
| `task content:typecheck` | Type-check Content. |
| `task content:test` | Run Content unit tests. |
| `task main:dev` | Run Main in watch mode. |
| `task main:relay` | Run the Main relay. |
| `task main:relay:init` | Initialize the Main relay. |
| `task main:typecheck` | Type-check Main. |
| `task source:names:publish` | Publish one bounded page of retained source-author names to native search; continue with --after from the result. |
| `task main:test` | Run Main unit tests. |
| `task model:typecheck` | Type-check the model package. |
| `task model:test` | Run model package tests. |
| `task ops:backup` | Fence a persistent stack and encrypt one signed recovery set to an off-host recipient. |
| `task ops:restore` | Verify and restore a signed recovery set into new isolated volumes; hold until checks pass. |
| `task ops:tdb2-scan` | Decode every TDB2 index tuple of a copied store and check pointers, indexes and node-to-id agreement. |
| `task ops:compact` | Compact stopped TDB2 with a retained recovery window, or explicitly rollback/retire it. |

<!-- toolchain-inventory:end -->

## Recovery encryption

`task ops:backup` and `task ops:restore` use host GnuPG 2.4.9 (verified by
`gpg --version` on 2026-10-01), with libgcrypt 1.12.2 on this host. Provision the
same tool on the recovery host and use standard recipient encryption/decryption;
no application cryptography replaces it. The capture host receives only the
public recipient key. Keep its private key off-host and keep the recovery HMAC
key in independent custody. The [recovery procedure](../operations/recovery.md)
owns keyring setup, serving holds and qualification limits.

## Phone engines for the launch journeys

The launch journeys also run on Playwright's WebKit (iPhone emulation) and on Chromium with Android emulation,
through `REZICS_E2E_PROJECTS` ([how](launch-accessibility.md#running)). WebKit is the version Playwright pins
(`playwright install webkit`), a host installation rather than a lockfile pin; it needs `libicu74` and
`libjpeg-turbo8`, which Fedora does not ship.

## Agent orchestration

The [Goal program](../goals/README.md) owns the worker lifecycle and commands;
the [manager charter](../goals/manager.md#resources) owns engine selection and
usage limits. CLI versions are host installations, not product pins. Workers use
the checked-in `scripts/goal/goalctl.ts` and its tests.
Fresh and resumed Codex workers and manager turns disable every MCP server listed in their account's `config.toml` with a `-c mcp_servers={...}` override that sets each server's `enabled=false`, leaving the maintainer's configuration untouched.

Open question: should Goal tooling support Windows? Measure on a Windows machine
before deciding line-ending and platform-module work. Support remains Linux-only
pending that decision.

### Goal mail and manager coordinator

`task goal -- mail` uses Bun's existing SQLite runtime with `synchronous=FULL`;
no mail daemon or additional package is required. `task goal -- coordinator`
uses the host's tmux and systemd user manager for the Codex pilot. tmux launches
finite native resumes through an existing server outside the coordinator unit's
cgroup. When the supervisor's `/proc/self/cgroup` identifies a systemd unit, each
fresh pass runs through `systemd-run --user --scope --collect`; its queue workers,
capacity continuations and landing wrappers inherit that separate scope and survive
a coordinator service fault. Scope execution preserves the caller's environment
([systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html));
argument expansion is disabled so the pass source is passed literally. If scope
creation fails before the pass starts, it runs in the supervisor's group and emits
a diagnostic; stopping the unit also kills those fallback processes. Outside
systemd, passes run directly. A failed pass reports its exit code and last error
line, records the failure time and line for `coordinator status`, and waits the
interval before the next pass; it does not end the supervisor. Launch descriptors
retain goalctl's model, effort, tier and account home.
The pilot verified tmux 3.7c and systemd 259.9 (259.9-1.fc44); these are host
installations rather than repository pins.

The user-unit template and handover commands are in
[`goal-coordinator.service`](../../scripts/goal/goal-coordinator.service). Before
activation, the maintainer supplies the unit's environment file with the PATH for
Bun, Task, tmux and Codex, verifies the previous interactive native owner has
exited, and enrolls one manager. `task goal -- coordinator status` shows pending
wake deadlines and refused/uncertain attempts. Uncertain claimed attempts require
manual reconciliation; missing completion is never permission for a second
resume. On the pilot host `Linger=no`; logout survival requires the maintainer to
enable lingering or choose a system service. The unit preserves
`KillMode=control-group` and does not change host login policy.

### Agent browser

Agents drive a real browser through [BrowserOS](https://github.com/browseros-ai/BrowserOS),
a Chromium fork with a built-in MCP server; it replaced the Claude in Chrome
extension for interactive browsing. Playwright stays for scripted tests, stories and repeatable
measurements.

- Host installation: v0.50.5 AppImage at `~/.local/opt/browseros/` (checksum
  verified against the GitHub release), launched by `browseros` or the desktop
  entry. It must be running for its MCP server to answer.
- MCP: `http://127.0.0.1:9200/mcp`, registered as `browseros` in every engine.
  The host keeps its shared MCP servers in one list, `~/.agents/mcp.json`, and
  `~/.agents/bin/mcp-sync` writes it through each engine's own configuration:
  Claude Code (user scope), the configured Codex homes, Grok and
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
