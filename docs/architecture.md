# Architecture principles

REZICS uses one graph and one generic engine across verticals. A new vertical adds definitions and presentation
configuration. Add backend capability only when the existing abstractions cannot express a required outcome.

Choose the simplest design that meets the requirement. Prefer mature engines, extensions, libraries and standards.
A custom mechanism needs evidence of the gap it fills and a comparison with the existing alternatives.

Every operation addresses a bounded neighbourhood. State its anchors, examined keys, expansion limits and indexed
cost. Bound reads, writes, authorization, validation, projections and cleanup. A response limit does not bound a scan,
sort, join, history walk or dependency fanout.

The bound applies to the rows a design reads through its own keys, fanout and expansion limits. Physical work the
database engine does for multiversion visibility, such as skipping versions from concurrent uncommitted transactions or
versions not yet vacuumed, belongs to the engine and its maintenance. Do not build product-level budgets or custom
primitives to meter it; use ordinary indexed SQL and keep the engine's maintenance healthy.

A composed operation's ceiling is the derived sum of its parts' finite bounds. Owners set and record the numbers; a
number that does not fit is raised, not a blocker. Only a design whose work grows with data is escalated.

Derive bounds on paper, enforce them with structural limits (full-key seeks, `LIMIT`, page and fan-out caps) and prove
them with growth checks. Do not build runtime price protocols between owners: no pre-I/O quotes, prepaid funding,
no-refill ledgers or per-profile dispatch allowances. When a contract needs a producer's cost, use the producer's
documented static bound as a constant.

Large jobs make bounded, resumable progress. Their total work may follow their finite input; individual steps may
not discover work through unrestricted scans or recomputation.

A capability must hold wherever its abstraction appears. Inclusion in public scope means the complete architectural
capability across its surfaces, rather than one working example.

One capability has one authority. Verticals, Realms, Zones and clients consume shared contracts rather than copying
their storage, query, permission or lifecycle mechanisms. Derived indexes and views do not become another authority.

Product writes, including imports, use the ordinary API and permission model. Fix an inadequate API rather than
creating a privileged parallel write path. Test fixtures are not product write paths.

Definitions own semantic vocabulary. Product modules own generic behaviour. Presentation configures how those
capabilities appear. A value's representation does not determine its semantic meaning or authority.

## Modules and boundaries

Decision: a dev candidate that adds boundary violations lands; the architecture check does not hold it. The train
records each Goal's net-new violations, and the same day an urgent repair brief per Goal, owned by its manager, removes
them as one batch. Development continues while the boundary baseline cannot drift.

Capabilities are modules with one owner and a declared public surface. Their structure is checked by tools, not by
convention. The evidence is in [engineering modularity (Opus 5.5)](research/engineering-modularity-opus-5-5.md) and
[(GPT-6 Astra)](research/engineering-modularity-gpt-6-astra.md).

**The module manifest.** Every production file belongs to one module of one kind, recorded in a machine-readable
manifest. The manifest gives each module's paths, owner Goal, public entries, allowed dependencies and the
capabilities it registers. The kinds are:

- **contract:** vocabulary, schemas and values;
- **core:** pure rules;
- **application:** use cases over ports;
- **adapter:** Elysia, Postgres, DBOS or Web runtime code;
- **composition root:** the code that wires a process together;
- **UI or transport library.**

**The rules.**

1. Each capability has exactly one registered mechanism and one owner. A second registry or ledger for the same
   concept is refused.
2. Cross-module imports go through declared public entries only, including type-only and generated imports.
3. The module graph is acyclic, and dependencies point from adapters and applications toward cores and contracts. No
   new value-import cycle is admitted anywhere. Shared numeric limits used across runtime dependency cycles live in
   a leaf module with no runtime imports; implementation modules import or re-export those values.
4. Cores and contracts are pure: no Elysia, `pg`, SQL, DBOS, React, runtime modules, environment, network, filesystem,
   clock or randomness. Time, IDs and facts arrive as values.
5. Adapters own effects, applications own use cases, and only composition roots choose implementations.
6. Each operation's wire and security metadata comes from one declarative operation descriptor, checked statically.
7. Shared code becomes a package under `packages/<capability>` only with a complete contract, conformance tests and
   two production consumers, or a recorded standalone requirement. A package never imports a service or an app.
8. Existing violations are listed in a ratchet baseline with an owner and a reason. The baseline may only shrink.
9. Importing a Kernel source file never evaluates values from another repository module, including workspace
   packages. Module initializers defer imported reads and calls behind functions or memoized getters; callers obtain
   the value at use. Shared literal data may be imported from a literal-only leaf with no runtime imports. Function
   bodies and instance fields are deferred; class inheritance, static fields, local initializer calls and registry
   construction are eager. Third-party packages are outside this repository graph. Process entry points run only
   when explicitly launched. Composition roots collect declared registrations before starting their resources.

Decision: Kernel computed values use memoized getters that retain value identity; literal-only leaves remain eager.
The syntax-tree architecture check enforces this at file boundaries, including within an architecture module.

Decision: Semantic subject facts, item projection and canonical identity run through registered contract, core,
application and adapter modules. Inward code uses Semantic-owned ports for Library custody, Search currentness,
Rating review, Content lifecycle, hashing and routing; composition binds the native adapters. Subject, summaries
and bulk HTTP resolve Content lifecycle through `adapters/ports.ts` and the composed registry; they do not
value-import `adapters/content-lifecycle.ts`, so native cover-reference stays out of that inward value graph.
A fake-port application loads without those implementations. Native authority and opaque proofs keep their owners.
Compact landing tests pin a fake-port domain and ordinary native composition; rating-review numeric bounds live in
the literal-only identity-core leaf `rating-review-bounds.ts`. After wiring, kernel-semantic baseline rule 2/3 is
361/383 (from 521/384); Kernel files in value cycles 398; largest value SCC 381.
Identity receiving publishes Library listing counts and Semantic read, subject source, receiving effects and the
production declaration as public entries; Search and composition import those ports. Accounts resume/wait stay on
`identity-epoch-coordinator.ts` so the Semantic barrel does not close a coordinator value cycle. Search and Library
import Source maintenance from `identity-source-consumer-maintenance.ts`; identity-adapters does not re-export those
values, because that edge closed a maintenance cycle.
Access public account identity and native Access ports import Semantic mapping from `semantic/agents.ts`. Original
recovery, read snapshots, Source custody and maintenance stay on those public entries; Semantic `access-capabilities.ts`
re-exports only mapping, so Access reads do not close a value-import cycle through recovery or Source maintenance.
Identity Rating repair values stay on `identity-rating-repair-producer.ts`; Source custody imports Library
`collection-native-work.ts`; composition binds Kind raw input so Access `access-capabilities.ts` is not a Kind/Source hub.

Decision: `config-check-runtime.ts` constructs check runners and reloads train settings from supplied dependencies; `createRuntime` keeps process, store and lifecycle ownership.

**Enforcement.** One static architecture check (manifest validation plus a dependency-graph check) runs on every
landing's final candidate. It needs no database and runs in seconds. Workers run the same check with `--changed`
before handoff. Receive changes through that manifest and check using actual public edges; do not add another writer,
an alias edge or an allowance. Every worker prompt carries the compact module-map rows for the modules that own the
brief's paths, plus those modules' allowed dependencies, and a one-line pointer to `docs/architecture/modules.json` for
the rest.

The production Kernel has one `createKernel` composition for module, route, event and resource registrations. Queue
registration completes before DBOS launch, and the composition injects one clock. Exposure, initializer and event
commit checks use their owner manifests; governance stays closed, including `read_reports`.

Library's contract, core and application modules are registered separately from the Source adapter. Contract
entries own work dimensions, Source, membership, ordering, capability ports and application results. Core owns
pure grant, page, ledger, identity-matching, publication-admission and catalogue/owner filter-leaf arithmetic.
Applications run against Library-owned ports; `composition/library.ts` binds native SQL catalogs and Access/Search/Semantic/Content
adapters during ordinary `createKernelRuntimeDefaults`, server and worker construction. Search filter-leaf
classification is a composition port, so the Search preparation adapter does not value-import Search.

Content's `community-projection/index.ts` is a registered pure core with no dependencies. Board and Realm adapters
supply selected native activity values and actor identity through that public entry, including its contract types;
`realm-board-home.ts` is the registered effectful Realm Board entry. DB reads, source selection/confirmation,
Access and schema mounting stay in adapters. The native conversation activity producer remains the one authority.

**Access.** The access model is a small pure policy core in `packages/access`. It compiles the permission catalogue
and plans the facts a decision needs. It decides with a per-operand explanation, and it partially evaluates list
requests into a closed filter that compiles to SQL over a bounded neighbourhood. Conformance vectors specify it
across languages. The Kernel keeps fact acquisition, temporal storage, revocation fences and command admission as
adapters. The catalogue is independent of HTTP routing. Cedar is the formal reference, not the engine; if the core
ever needs general recursion, host functions or a solver, adoption is reopened. Evidence:
[access model (Opus 5.5)](research/access-model-opus-5-5.md) and [(GPT-6 Astra)](research/access-model-gpt-6-astra.md).

The public `packages/access` permission-core APIs remain zero-runtime-dependency contracts. Their admission result
does not establish native, browser or finite-execution acceptance.

The Collection directory binds its qualified owner full-view result or the existing public floor; per-Collection
management grants do not widen another account's directory. The account's public face keeps public-floor semantics
even when its owner is viewing it.

## Data access

Pure bounds arithmetic and operation descriptors belong in contracts or cores, outside service handlers and
transport adapters. Native adapters bind through service composition roots.

Writes are single-partition commands. A read may not join rows across partitions; related reads start from an
authorized native anchor and use route-first indexed keys.

A batched key read is not a join and is admitted for reads. It uses one statement per row kind, selecting by full
keys with `(route, id) = ANY(keys)`, with no join between partitions. All of a read's batched statements run in one
`REPEATABLE READ` snapshot per database, grouped by the database that holds the partitions. Partition rows are read
the same way. A moved partition answers as it does for a single-partition read.

Statement bounds for these reads are stated per database.

First-public-scope boundaries live in [scope](scope.md). Detailed behaviour lives in the owning product document or
module README.
