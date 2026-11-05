# Architecture paradigms for a Kernel built by many agents (Opus 5.5)

Status: open. Research date 2026-11-06. Source revision `9ea85e35ee` (dev, 2026-11-06 04:38 +08:00). Desk research
plus read-only measurement scripts. No product code changed. This report builds on
[engineering modularity (Opus 5.5)](engineering-modularity-opus-5-5.md) and
[(GPT-6 Astra)](engineering-modularity-gpt-6-astra.md), whose rules were adopted in
[architecture](../architecture.md#modules-and-boundaries). It does not repeat their causal analysis of the work system.
It asks what *programming model* the Kernel and Web should use so that the adopted rules hold under agents.

## Question and answer in brief

Which architecture lets about 30 agents land thousands of files a week without entangling the Kernel?

**Answer.** Keep the adopted direction: one owner per capability, a manifest, levelled kinds, pure cores, adapters
for effects. It agrees with fifty years of literature. Three things are missing, and they are the ones that would
fail at our rate of change:

1. **The rules are not enforced, and the manifest encodes today's cycles.** `scripts/architecture.ts` exists, runs
   in 10.5 s and is called by no gate or prompt. Since its baseline was seeded, 2,145 commits in 15.6 hours added
   1,014 new violations (746 public-entry, 268 new value cycles). The manifest's `allowedDependencies` were
   snapshotted from the cyclic graph, so 18 of 49 modules sit on allowed-dependency cycles. The rule "the module
   graph is acyclic" holds only on paper.
2. **The unit of modularity is too coarse to verify.** Each Kernel domain is one manifest module of kind `adapter`
   (Access alone is about 390 files). Purity and effect rules therefore constrain almost nothing. A typical Kernel
   file loads 610 production files when imported (45% of the Kernel). 71% of Kernel test files load the largest
   cycle.
3. **Effects, state and time have no representation besides "call it".** Registrations happen by mounting functions
   on a shared Elysia app, constants are computed at module load from other modules, and the clock and randomness are
   called directly in 257 and 81 files. Nothing a module does to its environment is declared, so nothing can be
   checked before the whole system boots.

**Target paradigm: levelled capability modules with a functional core, effects passed as capabilities, and
registrations as declared values.** It combines Parnas's information hiding and Dijkstra/Lakos levelization (no
cycles, ever, at any granularity) with the effect literature's main practical lesson: the cheapest sound effect
discipline in a mainstream language is to pass capabilities explicitly (Effekt's "effects as capabilities") and to
declare what a component provides and requires (the coeffect side, made operational by the spatiotemporal
composability paper's Cordis). Every module states what it provides and requires; every effect a module has on its
environment is either a value it returns (a registration, a command, a durable step) or a call on a capability it was
handed. A worker verifies a module by running its tests under an import fence that loads only that module and its
declared dependencies' public entries, with fakes for its ports. The control plane enforces the static check, the
ratchet and the fenced module tests at landing.

**Do not adopt Effect (TypeScript) or another effect runtime now.** Its typed requirement channel is the right idea,
but the migration touches nearly every signature in 405,000 Kernel lines and its production evidence is testimonial.
Plain TypeScript capability records give most of the benefit at a fraction of the cost. This decision is reversible
(section "Recommended target paradigm").

The migration is ordered by measured cost removed: wire the existing check (stops about 65 new violations an hour);
forbid cross-module evaluation at module load (197 initialisers in 108 files; this is the boot-failure class);
declare registrations as values (the route-conflict class); pass ambient effects as capabilities; then split each
domain into contract, core, application and adapter modules and invert the 71 minority-direction domain edges that
hold the 387-file cycle together. Each step is priced in the section "Prices".

## Measurements from this repository

Method. `bun scripts/architecture.ts` (the repository's checker; full scan 10.5 s wall time) built the import graph
of 7,433 production files and refreshed `.temp/architecture/graph.json`. Read-only Python scripts in
`.temp/research/` (`measure.py`, `toplevel.py`; not committed, because `.temp/` is ignored) computed strongly
connected components (SCCs) over value imports, transitive closures, top-level initialisers and edge-removal
simulations. A "value import" is what the checker classifies as `value`; an import whose every specifier is a type is
excluded. Top-level initialisers and ambient effects were found by line-anchored regular expressions, so those counts
are approximate (they miss multi-line forms and may count a few false positives). Git history is from `git log` on
the same revision.

| Measure | Value on `9ea85e35ee` |
| --- | --- |
| Kernel production files (`services/kernel/src`, `.ts`) | 1,365 files, 405,370 lines |
| Kernel files in value-import cycles | 404 (30%) in 8 SCCs; largest SCC 387 files across 14 top-level modules (library 90, semantic 80, access 77, search 47, content 28, history 24, community 16, rating 9, commerce 5, others 11) |
| Kernel module-level cycle | 20 of 23 top-level directories in one SCC |
| Web production files (`apps/web/src`) | 2,325 files; 123 (5%) in value cycles; largest SCC 82 files (78 in `features`); 24 of 28 directories in one module-level SCC |
| Transitive value closure of a Kernel file | median 610 files, p90 618, max 1,258 |
| Kernel test files that load the largest SCC | 1,581 of 2,226 (71%); median test loads 610 production files |
| Kernel tests that reference a database or `createKernel` | 713 reference database support; 350 call `createKernel` |
| Effect-free Kernel lines | 4.7% transitively (no pg, Elysia, DBOS, SQL file, I/O built-in, Stripe or Bun import anywhere in the closure); 22.7% without a direct effect import |
| Top-level initialisers that evaluate an imported value | 506; 197 of them evaluate a value from another Kernel module, in 108 files; 148 files of the largest SCC run calls at load |
| Module-level mutable registries | 38 top-level `new Map`/`new Set`; 8 module-level `let` in 7 files; 18 exported `install*` setters |
| Ambient effects called directly | `Date.now()`/`new Date()` in 257 files; `Math.random`/`randomUUID` in 81; `process.env` in 14 |
| Database access style | 350 files export functions taking a client/pool parameter; 1 file imports a pool singleton |
| Architecture check, new violations | 1,014 not in the baseline (746 rule 2, public entries; 268 rule 3, new value cycles); baseline 9,714 entries of which 90 have disappeared |
| Commits since the baseline was seeded (2026-11-05 13:00 +08) | 2,145 commits in 15.6 hours touching 1,072 source files |
| Manifest modules on allowed-dependency cycles | 18 of 49 (all ten Kernel domain modules, all eight Web domain modules) |
| Manifest granularity | 14 Kernel modules; every domain module is one `adapter` module covering its whole directory |
| Weekly churn (2026-10-30 to 11-06) | 5,550 source files added, 6,788 touched in Kernel, Web and packages; 17,134 commits |
| Commits mentioning cycles, initialisation order or `ReferenceError` since 2026-10-25 | 222 (subject-line grep; includes some false positives) |
| Wiring of the architecture check | referenced only by `docs/architecture/README.md` and itself; not by `scripts/gate.ts`, `scripts/worker-check.ts` or `tools/goal` |

**What holds the cycle together.** The 387-file SCC contains 944 cross-module value edges between 83 module pairs.
They converge on few targets: `command/command.ts` receives 219, `http/problem.ts` 85, `request/access.ts` 53.
Removing all outgoing edges of the 3, 10, 20 and 40 most-imported targets still leaves an SCC of 345, 266, 221 and
about 147 files. No handful of hub repairs dissolves it. The 1,969 value specifiers on those edges are 1,163 functions,
532 type specifiers inside mixed value imports, 166 error classes, 57 constants, 37 factories and 14 schemas or classes.

Edge-removal simulations on the same graph:

| Simulated change | Largest SCC | Files in cycles |
| --- | ---: | ---: |
| Today | 387 | 404 |
| Move vocabulary (types, error classes, constants, schemas) to leaf contracts: 176 edges become non-cyclic | 362 | 381 |
| …and make infrastructure (`command`, `http`, `request`, `history`, `work`, `events` and other platform directories) import no domain module: 155 more edges | 301 | 340 |
| …and invert the minority direction of the 12 bidirectional domain pairs (71 edges, for example access→library 4 against library→access 58) | 65, all inside `library` | 219, all intra-module |

About 400 edge changes dissolve every cross-module file cycle. Vocabulary extraction alone, the first repair most
people reach for, removes 7% of the largest cycle. The cycle is made of behaviour calls between domains, mostly
between Library, Semantic, Access and Search (library→semantic 57, access↔semantic 26/29, search→semantic 38). After
these changes the *module* graph is still cyclic through longer chains outside the original SCC, so the module DAG
needs the declared levels described below, not only edge repairs.

**Reading.** The adopted rules describe the right structure, but on this revision none of them is binding: the check
is unwired, the manifest's allowed dependencies are themselves cyclic, and domain modules are a single `adapter` kind.
Workers cannot verify in isolation because a typical file's import closure is nearly half the Kernel. Boot failures
come from cross-module evaluation at load inside cycles: 197 initialisers do exactly what ECMAScript's cyclic module
evaluation turns into a temporal-dead-zone `ReferenceError` when the order shifts (section "What each idea predicts").

## Literature

### Spatiotemporal composability

### Effect systems in theory and practice

### Classic architecture literature

### Architecture for many parallel writers

## What each idea predicts for our failure

## Evaluation of the adopted architecture

## Recommended target paradigm

## Migration under a ratchet

## Prices

## Unverified claims

## Sources
