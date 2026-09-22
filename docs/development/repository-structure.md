# Repository organization proposal

Use one repository with a Cargo workspace and a Bun workspace. Organize executable
applications by product or service owner, reusable libraries by language, and
business behavior by domain inside its owner. Keep the existing documentation
owners. Repository membership does not imply one deployable or one release version.

The [Access placement research](../research/access-and-interaction-placement.md)
and [interaction bootstrap](../implementation/interactions-and-cache.md) place
Access inside Main and keep durable likes/favorites in TDB2 through Fuseki. Redis is outside
the first release's delivery and acceptance scope. It can later cache derived
reads without becoming another interaction authority.

This is a proposed layout for the fresh repository. Paths below describe intended
homes, not existing implementations. [The program plan](../plan/README.md) remains
the scope and qualification owner; this proposal does not activate runtime work.

## Constraints and alternatives

The [architecture](../architecture/overview.md) already selects TypeScript/Bun for
Account, Rust for Main and new domain/query integrations, React clients, Apache
Jena Fuseki + TDB2 + jena-text/Lucene,
private PostgreSQL owners and explicit service interfaces. The
[service map](../architecture/services.md) separates Account, Access, Main,
package runtime, workers and API/BFF responsibilities while hosting Access in Main. No old-system layout or
compatibility layer needs to survive the redesign.

| Organization | Benefit | Cost and decision |
| --- | --- | --- |
| Repository per service | Separate access controls and release administration. | Changes to the model, APIs and consumers require coordinated repository revisions. Defer until a real organizational or access boundary requires it. |
| Global `frontend/`, `backend/`, `shared/` | Few initial directories. | Does not identify private Account/Access ownership, the Main domain boundaries or generated contract ownership. Too ambiguous for this system. |
| Domain at the repository root, with all languages inside each domain | Keeps each capability's files close together. | Shared Main transactions and user journeys cross domains; it can suggest a deployable per content type. Use domain grouping inside the owning service instead. |
| Executable owners plus language workspaces | Contract and consumer changes can be reviewed together while service artifacts remain independent. | Requires explicit dependency checks. Recommended for the current redesign. |

The choice is a deduction from REZICS's change and ownership boundaries, not a
claim that monorepos are universally faster or easier to operate.

## Target directory map

```text
rezics-next/
├── README.md                    # Entry point, setup and links to design owners
├── AGENTS.md                    # Repository-wide working rules
├── Cargo.toml / Cargo.lock      # Rust workspace, shared dependency constraints
├── rust-toolchain.toml          # Pinned Rust toolchain
├── package.json / bun.lock      # TypeScript workspace and pinned package manager
├── .agents/skills/              # Scoped workflows
├── apps/                        # User/client entry points
│   ├── web/                     # React product, SSR/routes and web BFF
│   ├── mcp/                     # Adapter over owner APIs, when activated
│   └── cli/                     # Client commands, when activated
├── services/                    # Independently executable business owners
│   ├── account/                 # Bun/Elysia/Better Auth and private account state
│   ├── main/                    # Rust product service, including Access/interactions
│   ├── package-runtime/         # Resolution and recoverable installation
│   └── workers/                 # Job runners, split by workload when necessary
├── crates/                      # Reusable Rust libraries, as consumers require
│   ├── rezics-model/            # Generated semantic types and validation bindings
│   ├── rezics-service-clients/  # Owner API clients for Rust service consumers
│   └── rezics-jena/             # Reusable Fuseki HTTP/SPARQL client, if a consumer needs it
├── packages/                    # Reusable TypeScript packages
│   ├── model/                   # Generated semantic types and validation bindings
│   ├── api-client/              # Generated public/product HTTP clients
│   ├── service-clients/         # Internal clients; server-only exports
│   ├── ui/                     # Shared UI/SharkUI integration
│   └── i18n/                   # Locale infrastructure and shared messages
├── model/                       # Authored semantic definitions and their compiler
│   ├── schema/                  # Definition meta-schema and IR structure
│   ├── definitions/             # Resources, values, relations, operations, bindings
│   ├── compiler/                # Deterministic IR and derivative generation
│   └── tests/                   # Compiler, semantics and derivative conformance
├── generated/                   # Tracked exchange artifacts; never hand edited
│   ├── model/                   # Serialized IR, contexts and admitted shapes
│   └── openapi/                 # Per-owner, audience-specific HTTP descriptions
├── infra/                       # Runtime assembly, not business implementation
│   ├── dev/                     # Local service topology and configuration
│   ├── deploy/                  # Release/placement manifests and secret references
│   ├── observability/           # Collectors, dashboards and alert configuration
│   └── jena/                    # Pinned release, assembler and operational configuration
├── scripts/                     # Thin repository maintenance/automation
│   └── documentation/           # The documented link/owner checker location
├── tests/                       # Cross-owner executable acceptance
│   ├── integration/             # Account/Access/Main and worker protocols
│   ├── conformance/             # Engine/source/package profile qualification
│   └── recovery/                # Restart, restore and interrupted workflows
└── docs/                        # Existing design, contract and acceptance owners
```

Create directories with their first real implementation, not as a forest of empty
packages. `apps/mcp`, `apps/cli`, optional shared libraries and later worker runners
do not block the first product journey. A desktop client can join `apps/` when its
delivery scope starts. Root manifests list actual workspace members only.

An application may contain server code: the web BFF starts inside `apps/web` because
it adapts that product's sessions and requests. Introduce `services/bff` only if it
needs its own deployable lifecycle or serves several clients. It never becomes a
second domain or permission owner. Account's protocol routes and login flow stay
with Account; extracting a login UI later preserves that origin/session boundary.

Access runs as a Rust module inside Main; package runtime follows the selected
Rust backend direction. Worker language follows its actual integration; separate executable
packages under `services/workers/` can use different languages. This does not
require one operating-system process per job type at bootstrap.

## Main is modular inside one service

Start `services/main` as one Cargo package with a library and executable entry.
Use Rust module visibility and explicit public interfaces before introducing a
crate for every domain. Its domain map should follow existing contract owners:

| Main module | Owns |
| --- | --- |
| `access` | Private grants, representation, admission and fences; typed in-process interface and separately owned PostgreSQL schema. |
| `interactions` | Durable like/favorite/follow commands in TDB2 via Fuseki, receipts/outbox and optional derived read caching. High-frequency progress has an explicit coalescing/flush contract. |
| `identity` | Native Resource identity, public Agent descriptions and lifecycle. |
| `space` | Realm/Zone product state and participation workflows; effective admission stays in Access. |
| `context` | Context selection, fallback and interpretation. |
| `classification` | Concepts, expressions, applications and judgments. |
| `ratings` | Rating contexts, observations and aggregate policy. |
| `work` | Work, Main Version, contributions, revisions and publication selection. |
| `content` | Content components, composition, occurrences and exact anchors. |
| `catalog` | Native catalog facts, domain profiles and package release metadata. |
| `sources` | Source mappings, adoption and native correspondence; fetching runs in workers. |
| `community` | Curated collections, discussions and community workflows; ordinary mutable interaction edges have their own module. |
| `governance` | Reports, moderation, rights and disclosure workflows. |
| `query` | Admitted graph/text plans and cross-domain read composition; no second fact writer. |

For example:

```text
services/main/
├── Cargo.toml
├── src/
│   ├── main.rs                  # Process entry
│   ├── lib.rs
│   ├── bootstrap.rs             # Configuration, clients and route wiring
│   ├── transport/http/          # Axum adapters and HTTP schema export
│   ├── modules/
│   │   ├── classification/
│   │   │   ├── mod.rs           # Explicit interface to other modules
│   │   │   ├── commands.rs      # Use cases, authority and commit orchestration
│   │   │   ├── queries.rs       # Domain read requirements
│   │   │   ├── domain.rs        # Domain state and invariant rules
│   │   │   ├── storage.rs       # Owned predicates and guarded SPARQL binding
│   │   │   └── tests.rs         # Domain invariants and rejected states
│   │   └── ...
│   └── infrastructure/          # Engine/Account integration, object access, event relay
├── migrations/
│   ├── graph/                  # Main-owned vocabulary/data evolution
│   └── access/                 # Access-owned private SQL evolution
└── tests/                      # Actual engine and stateful owner API tests
```

These are responsibility examples, not mandatory files for every small module.
Split a large command into its own use-case folder when needed. Keep reusable
domain rules independent of HTTP and runtime clients. Commands may use concrete
SPARQL plans: an abstraction must not erase dataset/epoch/sequence fences,
conditional updates, graph semantics, receipt inspection or outbox atomicity.
Rust uses Fuseki HTTP; only the Fuseki JVM opens TDB2 and Lucene directories. Introduce ports where they serve a real
boundary, not a universal repository interface over every RDF resource.

Book, Software, Media, Recipe and Skill/Prompt remain profiles and capabilities
over the shared product spine. They can acquire focused submodules without each
reimplementing identity, revisions, classification or publication. Package catalog
facts remain in Main even when the installation code uses the same release types.

Cross-module reads use exported query surfaces or admitted composition by `query`.
Access decisions use its in-process interface; other modules do not query its
private tables directly. Co-location removes an RPC, not database reads or
cross-replica revocation requirements. Ordinary interaction mutations do not advance
the target's content revision or synchronously update one shared popularity counter.
Cross-module changes name one coordinating command and use participating owners'
validated changes. A shared TDB2 dataset permits one guarded SPARQL Update to coordinate
participating graph modules; separate HTTP calls do not share a transaction. Cross-service
steps continue to use receipts and reconciliation.

## Frontend follows user capabilities

Keep framework routing conventions inside `apps/web`, with feature code under
`src/features/`, product assembly under `src/shell/`, and session/transport/runtime
concerns under `src/infrastructure/`. Route files delegate to features. Example
feature names are `reading`, `studio`, `space-management`, `classification`,
`discovery` and `package-planning`; they need not mirror backend module names.

Each feature owns components, typed query adapters, state, messages, deterministic
tests and stories. Shared `packages/ui` holds reusable presentation primitives;
it does not fetch domain data or decide authority. Feature-specific messages stay
with their feature; `packages/i18n` holds the common runtime and genuinely shared
messages. SSR and browser navigation use the same selection and cache-key rules.

Features import shared packages or another feature's explicit public interface,
not its internal files. Cross-feature assembly belongs in the shell or a named
workflow. Extract reusable feature code only when another consumer actually needs
it. [Web organization](web-features.md) and [Storybook acceptance](storybook.md)
remain the behavioral owners for these boundaries.

## One authored definition, explicit generated derivatives

`docs/contracts` owns human-readable meaning. Root `model/` owns executable
definitions of that meaning; it is a build-time workspace package. It must not
import consuming services or its generated packages. `packages/model` and
`crates/rezics-model` are runtime consumers, with generated code in a clearly
marked `src/generated/` subtree and authored wrappers beside it.

```text
model/schema + model/definitions
    -> model/compiler
    -> generated/model: versioned IR, JSON-LD contexts, admitted SHACL subsets
    -> packages/model + crates/rezics-model: language bindings

owner HTTP mappings + shared model types + owner-private request/response types
    -> generated/openapi/<owner>/<audience>.json
    -> packages/api-client, packages/service-clients, crates/rezics-service-clients
```

Operation meaning comes from its definition; the owner declares its HTTP mapping
and private protocol types. Qualify schema export against that definition instead
of hand-maintaining equivalent Rust, TypeScript and OpenAPI records. Account's
credentials/tables and Access's private implementation records stay with their
owners; they do not enter the public model or browser bundle. Audience separation
also keeps internal operations out of the product client. Generated schemas never
replace runtime checks, authorization or domain state transitions.

Start with tracked generated exchange artifacts and language sources for review
and reproducible consumers. Record input digest, compiler/profile version and
artifact digest in the generation manifest. CI regenerates and rejects drift.
Build outputs such as `target/`, `dist/`, caches, captures and temporary reports are
ignored. If generated volume later becomes material, move distribution to pinned
artifacts as an explicit decision rather than quietly mixing tracked and untracked
sources. Generator/profile selection remains subject to the existing
[API qualification](../contracts/api.md), including `aide`/`schemars` evaluation.

## Dependencies, migrations and tests

Enforce these rules at bootstrap as packages become real:

1. Apps consume clients and UI packages. They never import service internals or
   database adapters. Shared packages cannot import apps or executable services.
2. Executable services call other owners through typed API/event contracts.
   `services/main` is not a library dependency of workers or package runtime.
   Logical modules hosted inside Main use explicit in-process interfaces; Access
   can expose a Main-hosted protected adapter for separately running consumers.
3. Rust reusable crates and TypeScript packages form acyclic dependency graphs.
   Shared code needs a named capability and consumer, not a generic `common`,
   `shared` or `utils` destination. Pure shared types carry no authority by themselves.
4. Account and Main-hosted Access keep separate migration directories, credentials
   and logical database ownership. Main owns graph evolution, including interaction
   shapes; each runner/runtime owns
   its checkpoint or inventory schema. `infra` runs owner migrations but does not
   absorb their definitions into a global schema directory.
5. Unit tests and stories live with their owner. Owner integration tests live in
   that service/package. Root `tests/` contains cross-owner journeys, not copies of
   local tests; `docs/testing` retains the prospective acceptance specification.
6. A service's container/build recipe stays beside its executable. `infra` owns
   composition, limits, placement and secret references. Jena/Fuseki is a pinned
   JVM dependency with its bundled Lucene, not copied wholesale into Rust Main.
   `infra/jena` owns assembler/index recipes, private endpoints and backup/rebuild
   wiring; a custom Java adapter is introduced only for an explicitly required
   and qualified capability.

Use Cargo manifests/metadata to check workspace dependencies and package exports
plus TypeScript lint/import checks to enforce browser/server and feature boundaries.
Cargo visibility handles private Rust modules; review or an architecture check
must still detect forbidden same-crate module dependencies. Merely putting files
in different folders does not enforce a boundary.

Cargo and Bun each own their lockfile and build graph. Use a thin root command
facade for generation and scoped checks; do not make a task runner a second
dependency registry. Start without a mandatory Nx/Turbo/Bazel layer. Introduce
caching/scheduling tooling only after build measurements justify it. Bun workspace
compatibility with the chosen React/Storybook build path must be exercised before
pinning the initial toolchain; Account's runtime choice alone does not prove that
entire toolchain works.

## Bootstrap sequence and acceptance

The checkout contains design documents, scoped skills and documentation integrity
tooling. Main, Account, web, model/compiler and runtime topology are not yet
implemented. The [graph quickstart](../operations/installation.md) and
[assembler](../operations/examples/fuseki-text.ttl) describe an independently
launchable dependency; they are not the completed product. Former `libraries/ui`,
`libraries/i18n`, `aspire-apphost` and legal-page locations are absent and must be
supplied by their actual implementation owners.

1. Establish the repository entry point, scoped working rules, toolchain pins and
   ignore policy. Maintain the documented documentation checks and align
   skill/document paths with actual implementation owners. Bring legal text and UI
   dependencies through their actual owning sources, without inventing replacements.
2. Ship one reviewed fixed model/shape profile with its Rust/TypeScript consumers
   and pinned candidate validator. Prove exact references, large numbers and
   omitted/null behavior. Grow the compiler and derivative-integrity checks as
   profiles are admitted; a universal compiler is not the first-command gate.
   Create each workspace manifest with real members; add further libraries only
   with a consumer. Model work can proceed alongside the minimum Account/Access
   interfaces needed for the first backend journey.
3. Deliver stage A/B from the [existing sequence](../plan/README.md#dependency-order):
   authentication/authority, guarded Main persistence, Space/context and a
   two-Realms/one-resource classification journey. Include receipts, rejected
   operations, stale authority and recovery; a directory scaffold is not this gate.
4. Extend through Work/Main Version/content, graph-integrated discovery, then
   source workers and package runtime in the existing dependency order. Develop
   affected frontend features with their APIs; retain all later capability scope.

The first topology should launch only participating owners and dependencies under
their documented authority rules. Start one Fuseki JVM with persistent TDB2 and
jena-text/Lucene, then add Main/Access and Account/PostgreSQL for the authenticated
journey. No Redis, broker, Java rewrite of Main or distributed graph tier is a
prerequisite. `infra/dev` can house an Aspire AppHost if
retained, but the copied Aspire skill is not a deployed topology or a prerequisite
to this repository layout. Scheduler and production placement remain under
[deployment assessment](../operations/deployment.md).

The layout is ready for continued implementation when a clean checkout can
reproduce generation and build the participating members, internal imports and
public/private boundaries are checked, an owner migration can run with only its
credentials, and the first cross-owner acceptance cases produce actual evidence.
Check a change to a shared definition through both languages and the affected API
client. Also check that a local UI change does not require editing Main internals.
These are prospective checks; this proposal has not executed runtime qualification.

## Evidence and limits

Primary sources consulted on 2026-09-22:

- [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)
  support members at different paths, one root lockfile and inherited dependencies
  and lints. This permits Rust service packages under `services/` alongside shared
  `crates/`; it does not require every package to live under `crates/`.
- [Bun workspaces](https://bun.sh/docs/pm/workspaces) support multiple packages and
  explicit local workspace dependencies. This supports one TypeScript workspace
  spanning apps, services, the compiler and generated packages; it does not
  establish React/Storybook or deployment bundler compatibility.
- [Nx project dependency rules](https://nx.dev/docs/kb/project-dependency-rules)
  illustrate explicit library roles and enforced import constraints. The selected
  lesson is to check dependency direction; this proposal does not select Nx or
  copy its complete library taxonomy.

The [Access research](../research/access-and-interaction-placement.md) and
[interaction/cache blueprint](../implementation/interactions-and-cache.md) retain
primary evidence, alternatives, bounded verification and remaining qualification.

The directory and extraction choices above are REZICS-specific recommendations.
Their principal uncertainties are generator compatibility, actual cross-module
coupling and frontend toolchain compatibility. The scoped bootstrap checks above
can change package granularity or tooling without reopening the selected service
ownership, native model or database architecture.
