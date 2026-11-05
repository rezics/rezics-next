# Architecture paradigms for a Kernel built by many agents (Opus 5.5)

Status: open (not adopted). Research date 2026-11-06. Source revision `9ea85e35ee` (dev, 2026-11-06 04:38 +08:00).
Desk research plus read-only measurement scripts. No product code changed. This report builds on
[engineering modularity (Opus 5.5)](engineering-modularity-opus-5-5.md) and
[(GPT-6 Astra)](engineering-modularity-gpt-6-astra.md), whose rules were adopted in
[architecture](../architecture.md#modules-and-boundaries). It does not repeat their causal analysis of the work system.
It asks what _programming model_ the Kernel and Web should use so that the adopted rules hold under agents.

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
   (Access alone is 156 TypeScript and 334 SQL files). Purity and effect rules therefore constrain almost nothing. A
   typical Kernel file loads 610 production files when imported (45% of the Kernel). 71% of Kernel test files load
   the largest cycle.
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

| Measure                                                                              | Value on `9ea85e35ee`                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel production files (`services/kernel/src`, `.ts`)                               | 1,365 files, 405,370 lines                                                                                                                                                                    |
| Kernel files in value-import cycles                                                  | 404 (30%) in 8 SCCs; largest SCC 387 files across 14 top-level modules (library 90, semantic 80, access 77, search 47, content 28, history 24, community 16, rating 9, commerce 5, others 11) |
| Kernel module-level cycle                                                            | 20 of 23 top-level directories in one SCC                                                                                                                                                     |
| Web production files (`apps/web/src`)                                                | 2,325 files; 123 (5%) in value cycles; largest SCC 82 files (78 in `features`); 24 of 28 directories in one module-level SCC                                                                  |
| Transitive value closure of a Kernel file                                            | median 610 files, p90 618, max 1,258                                                                                                                                                          |
| Kernel test files that load the largest SCC                                          | 1,581 of 2,226 (71%); median test loads 610 production files                                                                                                                                  |
| Kernel tests that reference a database or `createKernel`                             | 713 reference database support; 350 call `createKernel`                                                                                                                                       |
| Effect-free Kernel lines                                                             | 4.7% transitively (no pg, Elysia, DBOS, SQL file, I/O built-in, Stripe or Bun import anywhere in the closure); 22.7% without a direct effect import                                           |
| Top-level initialisers that evaluate an imported value                               | 506; 197 of them evaluate a value from another Kernel module, in 108 files; 148 files of the largest SCC run calls at load                                                                    |
| Module-level mutable registries                                                      | 38 top-level `new Map`/`new Set`; 8 module-level `let` in 7 files; 18 exported `install*` setters                                                                                             |
| Ambient effects called directly                                                      | `Date.now()`/`new Date()` in 257 files; `Math.random`/`randomUUID` in 81; `process.env` in 14                                                                                                 |
| Database access style                                                                | 350 files export functions taking a client/pool parameter; 1 file imports a pool singleton                                                                                                    |
| Architecture check, new violations                                                   | 1,014 not in the baseline (746 rule 2, public entries; 268 rule 3, new value cycles); baseline 9,714 entries of which 90 have disappeared                                                     |
| Commits since the baseline was seeded (2026-11-05 13:00 +08)                         | 2,145 commits in 15.6 hours touching 1,072 source files                                                                                                                                       |
| Manifest modules on allowed-dependency cycles                                        | 18 of 49 (all ten Kernel domain modules, all eight Web domain modules)                                                                                                                        |
| Manifest granularity                                                                 | 14 Kernel modules; every domain module is one `adapter` module covering its whole directory                                                                                                   |
| Weekly churn (2026-10-30 to 11-06)                                                   | 5,550 source files added, 6,788 touched in Kernel, Web and packages; 17,134 commits                                                                                                           |
| Commits mentioning cycles, initialisation order or `ReferenceError` since 2026-10-25 | 222 (subject-line grep; includes some false positives)                                                                                                                                        |
| Wiring of the architecture check                                                     | referenced only by `docs/architecture/README.md` and itself; not by `scripts/gate.ts`, `scripts/worker-check.ts` or `tools/goal`                                                              |

**What holds the cycle together.** The 387-file SCC contains 944 cross-module value edges between 83 module pairs.
They converge on few targets: `command/command.ts` receives 219, `http/problem.ts` 85, `request/access.ts` 53.
Removing all outgoing edges of the 3, 10, 20 and 40 most-imported targets still leaves an SCC of 345, 266, 221 and
about 147 files. No handful of hub repairs dissolves it. The 1,969 value specifiers on those edges are 1,163 functions,
532 type specifiers inside mixed value imports, 166 error classes, 57 constants, 37 factories and 14 schemas or classes.

Edge-removal simulations on the same graph:

| Simulated change                                                                                                                                            |              Largest SCC |       Files in cycles |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------: | --------------------: |
| Today                                                                                                                                                       |                      387 |                   404 |
| Move vocabulary (types, error classes, constants, schemas) to leaf contracts: 176 edges become non-cyclic                                                   |                      362 |                   381 |
| …and make infrastructure (`command`, `http`, `request`, `history`, `work`, `events` and other platform directories) import no domain module: 155 more edges |                      301 |                   340 |
| …and invert the minority direction of the 12 bidirectional domain pairs (71 edges, for example access→library 4 against library→access 58)                  | 65, all inside `library` | 219, all intra-module |

About 400 edge changes dissolve every cross-module file cycle. Vocabulary extraction alone, the first repair most
people reach for, removes 7% of the largest cycle. The cycle is made of behaviour calls between domains, mostly
between Library, Semantic, Access and Search (library→semantic 57, access↔semantic 26/29, search→semantic 38). After
these changes the _module_ graph is still cyclic through longer chains outside the original SCC, so the module DAG
needs the declared levels described below, not only edge repairs.

**Reading.** The adopted rules describe the right structure, but on this revision none of them is binding: the check
is unwired, the manifest's allowed dependencies are themselves cyclic, and domain modules are a single `adapter` kind.
Workers cannot verify in isolation because a typical file's import closure is nearly half the Kernel. Boot failures
come from cross-module evaluation at load inside cycles: 197 initialisers do exactly what ECMAScript's cyclic module
evaluation turns into a temporal-dead-zone `ReferenceError` when the order shifts (section "What each idea predicts").

## Literature

Citations give title, authors, year and link; the full list is under "Sources". Quotations are verbatim from the
source read; paraphrases are marked as such. Clones used: Effect (TypeScript) `cb679e3`, MIT; Packwerk `31e5342`, MIT;
Cordis `6663348`, MIT; Bun `c643ea8`, MIT. All are recorded in `.reference/INDEX.md` under `architecture-paradigms` or
`search-worker-outcome-harness`.

### Spatiotemporal composability

_A Programming Paradigm for Spatiotemporal Composability_, Yifan Shi, Wei Zhang and Tianyi Cui (Peking University;
DeepSeek-AI), arXiv:2608.25512 v1, 26 August 2026, 92 pages, arXiv non-exclusive distribution licence
(<https://arxiv.org/abs/2608.25512>). Read in full from the PDF; the HTML rendering does not exist. The implementation
is Cordis (<https://github.com/cordiverse/cordis>, MIT, read at `6663348`); the paper presents Cordis v4.

The paper names two dimensions of composition beyond ordinary function composition (section 1.1):

- **Temporal composability**: "upon removal of a component, the modifications the component made to the shared
  environment must be completely and safely reversed."
- **Spatial composability**: "components must be able to declare, discover, and resolve their dependencies on one
  another in a structured and verifiable manner."

In the static setting the paper reduces the first to lexical scoping (RAII, bracket patterns) and the second to
module import resolution. Its mechanisms:

1. **Revertible effects** (section 3.1). An effect is modelled as `Γ → Γ × (Γ → Γ)`: it returns the changed context
   _and_ its inverse, and inverses compose in reverse order. In Cordis every context mutation goes through one
   primitive, `ctx.effect(callback)`, whose callback returns its disposer (section 5.1.1;
   `packages/core/src/fiber.ts:292`). Event listeners, timers (`packages/timer/src/index.ts`), service provision and
   child components all reduce to it, so unloading a component reverts everything it registered.
2. **Reactive coeffects** (section 3.2). A component declares the keys it requires (`inject`) and the keys it
   provides. Each context change is classified against that specification, and the component is activated only while
   its requirements are satisfied.
3. **The context paradigm** (section 3.3). Effects and coeffects are unified in one context type, and "every
   interaction between a component and its environment passes through this single entity". Operations on a key act
   only on that key's binding, which yields an observational equivalence under which the effects of distinct
   components interleave without disturbing one another (sections 3.3.2, 3.4).
4. **Cycles** (section 6.5). A dependency cycle leaves the components permanently inactive, and "this condition is
   predictable from the dependency declarations alone, so a runtime can report it when components are loaded." The
   paper's remedy is decomposition: a server and an access controller that call each other become _server-core_,
   _access-control-core_, _request-mediation_ and _policy-management_; "neither core depends on the other; only the
   integration components depend on both." The cost is more components, up to quadratic in mutually interacting
   components, which it proposes to mitigate with bundling, convention-based wiring and scaffolding.
5. **Limits it states.** Linking is nominal by key name, so interface drift and key collisions are possible across
   independently built components (section 6.6). The Koishi case study (section 5.3: a chatbot framework with "over
   4000 community-contributed plugins") is "an existence-and-adoption result rather than a quantitative one";
   overhead and productivity against a baseline are future work. Effects that leave the system boundary (bytes
   written, messages sent) cannot be reverted, only withheld or compensated (section 6.1).

For REZICS the relevant part is not hot reload. It is that a component's whole effect on its environment and its whole
dependence on it are _declared values_ that a runtime, or a static check, can inspect. The paper's section 6.5
example is our own failure: the `IDEMPOTENCY_HEADER` boot failure was a cycle between HTTP problem mapping and Access.

### Effect systems in theory and practice

- **Effect systems.** _Polymorphic Effect Systems_, John M. Lucassen and David K. Gifford, POPL 1988
  (<https://doi.org/10.1145/73560.73564>): types annotated with the effects a computation may have, originally to find
  what can run in parallel. That motivation is ours: knowing what code touches tells you what can be changed and
  checked independently.
- **Algebraic effects and handlers.** _Algebraic Operations and Generic Effects_, Gordon Plotkin and John Power, 2003
  (<https://doi.org/10.1023/A:1023064908962>), and _Handlers of Algebraic Effects_, Gordon Plotkin and Matija Pretnar,
  ESOP 2009 (<https://doi.org/10.1007/978-3-642-00590-9_7>). An effect is an interface of operations; a handler gives
  it meaning; the same code runs under a production handler or a test handler. This is ports and adapters stated as
  semantics (paraphrase).
- **Koka.** _Koka: Programming with Row Polymorphic Effect Types_, Daan Leijen, MSFP 2014
  (<https://doi.org/10.4204/EPTCS.153.8>), and _Type Directed Compilation of Row-Typed Algebraic Effects_, Daan Leijen,
  POPL 2017 (<https://doi.org/10.1145/3009837.3009872>). Every function's type carries an inferred row of effects;
  a function with an empty row is pure. The key practical property is inference: the programmer does not write the
  rows, the compiler reports them.
- **Effekt and capability passing.** _Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism_,
  Jonathan Immanuel Brachthäuser, Philipp Schuster and Klaus Ostermann, OOPSLA 2020
  (<https://doi.org/10.1145/3428194>). Effect types are read as the capabilities a computation needs from its
  context; handlers are passed explicitly (capability-passing style) and functions are second class to keep
  capabilities from escaping. The authors trade some purity reasoning for much simpler effect polymorphism and
  encapsulation (paraphrase of the abstract). _Capturing Types_, Aleksander Boruch-Gruszecki, Martin Odersky, Edward
  Lee, Ondřej Lhoták and Jonathan Brachthäuser, ACM TOPLAS 2023 (<https://doi.org/10.1145/3618003>), brings the
  same idea to Scala as capture checking. Object capabilities in general: _Robust Composition_, Mark S. Miller, PhD
  thesis, Johns Hopkins University, 2006 (<http://www.erights.org/talks/thesis/>): authority flows only through
  references you were given.
- **Coeffects.** _Coeffects: A Calculus of Context-Dependent Computation_, Tomas Petricek, Dominic Orchard and Alan
  Mycroft, ICFP 2014 (<https://doi.org/10.1145/2628136.2628160>): the dual of effects, tracking what a computation
  _requires_ from its context. The spatiotemporal paper builds its spatial dimension on this.
- **Effect handlers in a production language.** _Retrofitting Effect Handlers onto OCaml_, KC Sivaramakrishnan,
  Stephen Dolan, Leo White, Tom Kelly, Sadiq Jaffer and Anil Madhavapeddy, PLDI 2021
  (<https://doi.org/10.1145/3453483.3454039>). OCaml 5 ships untyped handlers; effects are not in function types.
  This shows the industrial compromise: the runtime mechanism shipped, the static effect tracking did not.
- **Effect (TypeScript).** Effect-TS/effect `cb679e3`, package `effect` 4.1.2, MIT. `Effect<A, E, R>` is "a value that
  lazily describes a workflow or job. The workflow requires some context `R`, and may fail with an error of type `E`"
  (`packages/effect/src/Effect.ts:98-100`). "A `Layer<ROut, E, RIn>` describes how to acquire one or more services,
  which services are required to build them, and which errors can occur during acquisition"
  (`packages/effect/src/Layer.ts:4-6`). Test services such as `testing/TestClock.ts` replace time. `R` is a
  compile-time coeffect: a program that still requires a service does not type-check as runnable. Production evidence
  is from Effect's own podcast, _Cause & Effect_ (<https://effect.website/podcast/>): Zendesk ("one of their main
  products, serving millions of users every day", episode 1, 2024-11-26; the guest credits dependency injection,
  layers and an incentive to write unit tests), Markprompt, MasterClass, Vercel, Spiko, OpenRouter, Warp and OpenCode
  (episode 8, 2026-06-19, migrating "a large TypeScript codebase to Effect"). These are testimonials from the
  vendor's channel. No controlled study or published defect or throughput numbers were found.

**What practice shows.** Typed effect tracking (Koka rows, Effekt capabilities, Effect's `R`) works when the compiler
infers or checks it on every edit. Where the language cannot, systems keep the _runtime_ half (handlers, layers,
disposers) and enforce the static half with conventions and tools (OCaml 5, Cordis, plain dependency injection). For
TypeScript the choice is between (a) adopting a library whose types carry requirements, which rewrites every effectful
signature, and (b) passing capability records explicitly and checking imports, which keeps signatures but gives up
inference of what a function may do.

### Classic architecture literature

- **Parnas, decomposition criteria.** _On the Criteria To Be Used in Decomposing Systems into Modules_, David L. Parnas,
  CACM 1972 (<https://doi.org/10.1145/361598.361623>): "We propose instead that one begins with a list of difficult
  design decisions or design decisions which are likely to change. Each module is then designed to hide such a
  decision from the others." Decomposing by processing steps, as a flowchart, couples every module to shared
  representations. _Designing Software for Ease of Extension and Contraction_, David L. Parnas, IEEE TSE 1979
  (<https://doi.org/10.1109/TSE.1979.234169>), adds the _uses_ relation: when it is loop-free, every level is a usable
  and testable subset of the system; when it loops, "nothing works until everything works" (paraphrase).
- **Dijkstra, THE.** _The Structure of the "THE"-Multiprogramming System_, Edsger W. Dijkstra, CACM 1968
  (<https://doi.org/10.1145/363095.363143>). Six layers, each using only those below. The paper credits the hierarchy
  for making exhaustive testing of each level feasible before the next was added (paraphrase).
- **Conway.** _How Do Committees Invent?_, Melvin E. Conway, Datamation 1968
  (<https://www.melconway.com/Home/Committees_Paper.html>): "organizations which design systems ... are constrained
  to produce designs which are copies of the communication structures of these organizations." Empirical test:
  _Exploring the Duality between Product and Organizational Architectures: A Test of the "Mirroring" Hypothesis_,
  Alan MacCormack, Carliss Baldwin and John Rusnak, Research Policy 2012
  (<https://doi.org/10.1016/j.respol.2012.04.011>): loosely coupled organisations (open source) produced
  significantly more modular products than tightly coupled ones (paraphrase). _Identification of Coordination
  Requirements_, Marcelo Cataldo, Patrick Wagstrom, James Herbsleb and Kathleen Carley, CSCW 2006
  (<https://doi.org/10.1145/1180875.1180929>): changes are completed faster when coordination matches the
  dependencies among the work (paraphrase).
- **Baldwin and Clark, design rules.** _Design Rules, Volume 1: The Power of Modularity_, Carliss Baldwin and Kim
  Clark, MIT Press 2000 (<https://mitpress.mit.edu/9780262024662/>). Parallel independent work becomes possible when
  a small set of _visible design rules_ (architecture, interfaces, tests) is fixed first and everything else is hidden
  in modules (paraphrase).
- **Lakos, levelization.** _Large-Scale C++ Software Design_, John Lakos, Addison-Wesley 1996 (ISBN 0-201-63362-0).
  Physical design: components get a _level_ (1 + the highest level they depend on); a system is levelizable only if
  its component dependency graph is acyclic; cyclic physical dependencies defeat understanding, testing and reuse
  because no part can be tested without the rest. He measures coupling with cumulative component dependency (CCD), the
  sum over components of the number of components each needs to be tested (paraphrase). Our median closure of 610
  files is that measure per file.
- **Martin, package principles.** _Design Principles and Design Patterns_, Robert C. Martin, 2000
  (<https://web.archive.org/web/20150906155800/http://www.objectmentor.com/resources/articles/Principles_and_Patterns.pdf>),
  and _Agile Software Development: Principles, Patterns, and Practices_, Prentice Hall 2002. Acyclic dependencies
  principle: "Allow no cycles in the package dependency graph." Stable dependencies principle: "Depend in the
  direction of stability." Stable abstractions principle: a package should be as abstract as it is stable. Cycles are
  broken by dependency inversion: the depended-on side declares an interface the other implements.
- **Cockburn, ports and adapters.** _Hexagonal Architecture_, Alistair Cockburn, 2005
  (<https://alistair.cockburn.us/hexagonal-architecture/>): "Allow an application to equally be driven by users,
  programs, automated test or batch scripts, and to be developed and tested in isolation from its eventual run-time
  devices and databases."
- **Functional core, imperative shell.** Gary Bernhardt, _Boundaries_, SCNA 2012
  (<https://www.destroyallsoftware.com/talks/boundaries>), and the screencast _Functional Core, Imperative Shell_,
  2012 (<https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell>): simple values as
  the boundaries between components; decisions in a pure core tested without mocks; a thin shell with few
  conditionals performs the I/O (paraphrase).
- **Out of the Tar Pit.** Ben Moseley and Peter Marks, 2006 (<https://curtclifton.net/papers/MoseleyMarks06a.pdf>).
  Complexity is the main difficulty in large systems; its main sources are state and control. They separate essential
  state (what users supply), essential logic (pure derivation) and accidental state and control (performance hints),
  and recommend keeping accidental parts out of the logic altogether (paraphrase). A module-level cache or registry is
  accidental state with global reach.

### Architecture for many parallel writers

Large organisations and recent agent studies. Evidence about model behaviour is limited to work under four months old
(after 2026-07-06).

- **Google.** _Why Google Stores Billions of Lines of Code in a Single Repository_, Rachel Potvin and Josh Levenberg,
  CACM 2016 (<https://doi.org/10.1145/2854146>): one trunk with tens of thousands of engineers works because of build
  tooling that knows every dependency and tests affected targets (paraphrase). _Software Engineering at Google_, Titus
  Winters, Tom Manshreck and Hyrum Wright, O'Reilly 2020, chapter 18 (<https://abseil.io/resources/swe-book>):
  fine-grained modules, the "1:1:1" rule (one directory, one package, one build target) and visibility restrictions
  keep the build graph explicit (paraphrase). Bazel enforces it: a target may only be depended on by packages its
  `visibility` lists (<https://bazel.build/concepts/visibility>).
- **Uber.** _Keeping Master Green at Scale_, Sundaram Ananthanarayanan et al., EuroSys 2019
  (<https://doi.org/10.1145/3302424.3303970>): with hundreds of changes a day, a submit queue that builds and tests
  candidate changes speculatively, using the build graph to find independent changes, keeps trunk green; conflict
  analysis relies on target-level dependencies (paraphrase).
- **Shopify.** _Enforcing Modularity in Rails Apps with Packwerk_, Maple Ong, 2020-09-23
  (<https://shopify.engineering/enforcing-modularity-rails-apps-packwerk>), and _A Packwerk Retrospective_, Gannon
  McGibbon and Chris Salzberg, 2024-02-07 (<https://shopify.engineering/a-packwerk-retrospective>). Packwerk kept a
  "deprecated references list" as a ratchet, like our baseline. The retrospective's findings: dependency checks
  provided "value in holding the line against new dependencies at the base layer"; privacy checks turned Packwerk into
  "an API design tool" and were removed in v3.0. A package brought to zero violations still would not boot in
  isolation, because constants loaded outside the tracked mechanism are "untracked and invisible to the tool", so "a
  package that is well-defined according to Packwerk (has no violations left to resolve) may actually crash with name
  errors when its code is executed." Their conclusion: "running code, more than any metric, will always be the best
  indicator of real progress."
- **Semantic interference between parallel agents.** _Passes Alone, Fails Together: Benchmarking Semantic Coordination
  in Parallel LLM-Agent Development_, Haocheng Xia, Eugene Wu and Yongjoo Park, arXiv:2609.25396, 2026-09-21
  (<https://arxiv.org/abs/2609.25396>). On constructed interface changes to 12 Django helpers, 105 of 108 blind
  GPT-5.5 runs (97%) produced patches that each passed alone but failed when merged, despite clean textual merges.
  A roughly 130-token description of the completed interface change recovered 82% (in the synthetic tier it cut
  interference from 2.50 to 0.04 per run). On 417 mined Django PR pairs, interference was rare (1 of 834 runs), which
  the authors attribute to history that review had already reconciled. "This happens when one agent changes an
  interface or rule that another agent still relies on." The authors warn that the constructed rates do not estimate
  real frequency.
- **Pre-write admission.** _Claim Plane: Reliability Gains and the Limits of Selective Concurrency for Parallel Coding
  Agents_, Maxim Nikolaev, arXiv:2608.00947, 2026-08-02 (<https://arxiv.org/abs/2608.00947>; abstract only, the full
  text could not be extracted). On 30 CooperBench feature pairs, static admission over declared change scopes raised
  pair pass from 23.3% to 50.0% and integration success from 65.6% to 96.7%, but it "recovered reliability largely by
  collapsing toward serial execution" (96.7% of executions serialised). Dynamic admission failed closed on undeclared
  scope in 46 of 90 executions.
- **Queue governance.** _BulkPR-Bench: Benchmarking Queue-Level Governance of Interacting Pull Requests_, Zetong Xiong
  et al. (23 authors, Baidu), arXiv:2608.02685, 2026-08-03 (<https://arxiv.org/abs/2608.02685>). Six current models
  selecting safe merge subsets from 581 candidate PRs in 18 repositories completed only 8 of 324 queues exactly; unsafe
  merges occurred in 226 runs; agents respected 98–100% of the relations they recovered, so the gap is _recovering_
  relations, and supplying the relation graph raised scores to 77.5–99.1%.
- **Context only.** _AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates_, George Xu,
  Arjun Subramanian and Nithilan Karthik, arXiv:2607.04697, 2026-07-06 (<https://arxiv.org/abs/2607.04697>). Its data
  covers December 2024 to July 2025, so it fails the four-month rule for model behaviour; cited only for the
  observation that textual conflicts are a lower bound because build and semantic conflicts are not tracked.

**What the recent evidence says.** Agents mostly fail together, not alone, and they fail on relations they cannot
see: changed interfaces (Xia et al.), interacting PRs (BulkPR-Bench), undeclared scope (Claim Plane). Making the
relation explicit and machine-readable recovers most of the loss. Serialising on declared file scopes also works but
gives up the parallelism we need. Explicit, small, checked interfaces between modules are the form of "relation
graph" that does not serialise work.

## What each idea predicts for our failure

Four symptoms, from the brief: agents add imports that close cycles; modules compute values at load time from other
modules; effects run through 95% of the code; verification needs the whole system.

| Idea                                     | Agents closing cycles                                                                                                                                                                                                                       | Cross-module computation at load                                                                                                    | Effects everywhere                                                                                                             | Whole-system verification                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Parnas 1972 (information hiding)         | A worker imports the file that has the function it needs because nothing marks it as a hidden decision; modules split by feature journey, the flowchart decomposition Parnas warns against, so every journey touches shared representations | Load-time computation exposes a module's internal representation (bounds sums, schemas) as a dependency of others' initialisation   | Effects are design decisions likely to change (database, DBOS, Elysia); unhidden, every module depends on them                 | A module whose secrets are not hidden cannot be tested against its interface                                     |
| Parnas 1979 (loop-free _uses_)           | Predicts exactly "nothing works until everything works": one loop and no subset is testable                                                                                                                                                 | Initialisation order is a _uses_ relation at load time; a loop makes it undefined                                                   | —                                                                                                                              | Loop-free _uses_ is the precondition for testing subsets; we have none                                           |
| Dijkstra THE (layers)                    | A layer may use only those below; a cycle is a layering violation by definition                                                                                                                                                             | Layers initialise bottom-up; cross-layer initialisation is impossible by construction                                               | Effects belong to designated layers                                                                                            | Each layer is verified before the next exists; we verify only the whole                                          |
| Conway / mirroring                       | Domain modules mirror Goals (0.80–0.98 owner share, earlier report); infrastructure has no owner and the most writers, so it becomes the cycle's hub (`command.ts` receives 219 SCC edges)                                                  | —                                                                                                                                   | —                                                                                                                              | Workers that do not communicate produce modules that only meet at boot                                           |
| Lakos (levelization, CCD)                | A cycle merges all its members into one level; CCD jumps                                                                                                                                                                                    | Static initialisation across components is the classic C++ "static initialisation order fiasco"; the same class appears here as TDZ | —                                                                                                                              | CCD ≈ test cost: median closure 610 files means each test needs half the Kernel                                  |
| Martin (ADP, SDP, SAP)                   | Cycles break ADP; infrastructure (most depended on, should be most stable) imports volatile domain code, breaking SDP                                                                                                                       | Concrete computation in stable modules breaks SAP                                                                                   | —                                                                                                                              | Fix by inversion: the stable side declares an interface                                                          |
| Ports and adapters                       | —                                                                                                                                                                                                                                           | —                                                                                                                                   | Business rules call effects directly instead of through ports; 4.7% effect-free                                                | Predicts our state: without ports, tests need the real database (713 test files)                                 |
| Functional core / imperative shell       | —                                                                                                                                                                                                                                           | Load-time computation is shell work done at import                                                                                  | Predicts that decisions are tested only through I/O                                                                            | A pure core would be testable by values, in milliseconds                                                         |
| Out of the Tar Pit                       | —                                                                                                                                                                                                                                           | Module-level registries and caches are accidental state with global reach (38 top-level maps, 18 `install*` setters)                | Control and state woven through logic are the main source of complexity                                                        | Tests must reconstruct all accidental state, hence `createKernel` in 350 tests                                   |
| Effect systems (Koka, Effekt, Effect)    | —                                                                                                                                                                                                                                           | —                                                                                                                                   | An effect type or capability makes effects visible in signatures; absent that, any call may do anything and agents cannot know | Handlers or layers substitute test implementations; requires effects to be reachable only through them           |
| Coeffects / spatiotemporal composability | Requirements declared as keys make cycles "predictable from the dependency declarations alone"                                                                                                                                              | Registrations as `ctx.effect` values with inverses replace import-time side effects                                                 | Every interaction goes through one context, so it can be observed and faked                                                    | A component can be loaded alone with its declared requirements satisfied by test providers, and unloaded cleanly |
| Packwerk retrospective                   | Dependency checks hold the line on new edges                                                                                                                                                                                                | Untracked load mechanisms let a "clean" package crash at run time                                                                   | —                                                                                                                              | Zero static violations did not make a package boot alone; only running it in isolation proves isolation          |
| Recent agent studies                     | Agents respect the relations they can see (98–100%, BulkPR-Bench) and miss the ones they cannot                                                                                                                                             | —                                                                                                                                   | —                                                                                                                              | Agents' changes pass alone and fail together when an interface changes silently (97% in constructed cases)       |

**The mechanism of the boot failures.** ECMAScript evaluates a strongly connected set of modules in one depth-first
pass; a module whose import is still being evaluated sees that binding in its temporal dead zone, and reading it
throws a `ReferenceError` (ECMA-262, _Cyclic Module Records_ and _InnerModuleEvaluation_,
<https://tc39.es/ecma262/#sec-cyclic-module-records>). Functions declared but not called at load are harmless in a
cycle. Cycles become fatal only when combined with **evaluation at load across the cycle**: a top-level `const`
computed from an imported value. Which import runs first depends on the entry point and on import order, so a new
import anywhere in the 387-file SCC can reorder evaluation and break a file nobody touched. We have both
ingredients: 404 files in cycles and 197 cross-module top-level initialisers in 108 files, 148 SCC files calling
functions at load. The literature agrees on the fix: remove the cycles (Parnas, Dijkstra, Lakos, Martin), and until
then forbid cross-module evaluation at load (Lakos's static-initialisation rule; Cordis's "every mutation through the
context", which makes registration a runtime call rather than an import side effect).

**Agents are a special case of Conway, not an exception.** Thirty agents that never talk to each other are the
loosest-coupled organisation possible. Mirroring predicts modular products from loosely coupled organisations only
when the interfaces are fixed first (Baldwin and Clark's design rules). Without visible design rules, independent
writers re-derive mechanisms and import whatever compiles. The agent studies say the same at small scale: the
interface relations they are shown are respected; the ones they must discover are broken.

## Evaluation of the adopted architecture

The adopted rules are in [architecture](../architecture.md#modules-and-boundaries) and implemented by
`scripts/architecture.ts` with `docs/architecture/modules.json` and `boundary-baseline.json`.

**What is right.**

| Adopted element                                                                                         | Literature support                                                       | Comment                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| One owner and one mechanism per capability                                                              | Parnas (one secret per module), Conway, Cataldo et al.                   | Correct; ownership is what makes inversion and consolidation someone's job |
| Manifest with public entries and allowed dependencies                                                   | Bazel visibility, Packwerk, Lakos physical design                        | Correct form; machine-readable, checkable without running code             |
| Kinds (contract, core, application, adapter, composition root) and direction toward cores and contracts | Dijkstra layers, Lakos levels, Martin SDP/SAP, Cockburn, functional core | Correct; this is the levelled structure every source recommends            |
| Pure cores and contracts: no I/O, clock, randomness; time and IDs as values                             | Functional core, Out of the Tar Pit, Effekt (capabilities from outside)  | Correct and specific                                                       |
| Only composition roots choose implementations; one `createKernel`; one injected clock                   | Ports and adapters, Effect layers, Cordis loader                         | Correct                                                                    |
| One declarative operation descriptor per operation, checked statically                                  | Spatial composability (declared keys), Bazel                             | Correct; removes boot-time route conflicts once complete                   |
| Ratchet baseline that may only shrink                                                                   | Packwerk's deprecated references, the earlier reports                    | Correct                                                                    |
| Static check in seconds; `--changed` mode; module map in prompts                                        | Uber/Google (graph-aware checks), agent studies (show relations)         | Correct design; 10.5 s measured                                            |

**What is missing.**

1. **Enforcement.** The check is wired to nothing. 1,014 new violations in 15.6 hours is the predictable result
   (Packwerk's experience is that dependency checks only "hold the line" when they gate). This is the largest gap and
   the cheapest to close.
2. **An acyclic declared graph.** Allowed dependencies were seeded from the current imports, so the manifest
   _declares_ the cycle: 18 of 49 modules are on allowed-dependency cycles. The rule "the module graph is acyclic" is
   therefore unenforceable at module level; only rule 3 (new file-level value cycles) catches anything. The target
   graph must be declared as a DAG and the existing back edges moved into the baseline, where they can only shrink.
3. **Granularity.** Every Kernel domain is one `adapter` module. Purity rules apply to 13 small `core` modules; 95% of
   the code is in modules where anything is allowed. Lakos's unit of levelization is the _component_, a file pair, not a
   directory of hundreds of files. The kinds must apply inside domains: `access/contract`, `access/core`, `access/application`,
   `access/adapters`, and so on.
4. **No rule about evaluation at load.** The rules govern _what_ may be imported, not _what may run when imported_.
   Cross-module top-level computation is what turns a cycle into a boot failure; it has no rule, no check, no count.
5. **No representation of registrations.** Modules mount themselves on a shared app (`modules?: ((app) => void)[]` in
   `http/kernel.ts:147`) and conflicts surface only when `createKernel` runs. Descriptors are adopted for operations
   but not for events, queues, permission catalogue entries or projections. The spatiotemporal paper's point is that
   all of these are effects on a shared context and should be declared values with inverses.
6. **No representation of ambient effects outside cores.** The clock rule applies to cores; adapters and applications
   call `Date.now()` in 257 files. Since 95% of the code is not a core, the rule binds little.
7. **No isolated verification.** Nothing lets a worker run a module without the system, and nothing proves that a
   module with zero static violations actually runs alone. Packwerk's retrospective shows that static cleanliness and
   runtime isolation diverge; Lakos and Parnas define isolation _by_ testability of a subset.
8. **Interface changes are silent.** When a contract's export changes, dependents learn at integration. The agent
   evidence says this is the dominant failure of parallel writers and that a short explicit description of the change
   recovers most of it.

**What would fail at our rate of change.**

- _A baseline that is not gated_ grows faster than any owner can shrink it: about 65 an hour against 90 removed in a
  day.
- _Coarse modules_ hide new cycles inside them. With a domain-sized `adapter`, rule 2 (public entries) cannot see
  intra-domain deep imports, and every new file is free to import any other file of its domain.
- _Snapshotted allowed dependencies_ teach agents that whatever compiles is allowed: once a module pair is allowed,
  new file edges in either direction pass rule 2.
- _Rules that need judgment_ (is this a core? is this constant shared?) are applied inconsistently by 30 agents. Rules
  must be decidable by the tool from the path and the import, as the manifest already intends.
- _A single boot test as the only runtime proof_ serialises everything behind one expensive check and blames the
  wrong change. Module-local runtime proofs scale with the change.

## Recommended target paradigm

**Levelled capability modules: a functional core, effects passed as capabilities, registrations as declared
values.** Five rules carry it; each is decidable by a tool from paths and imports.

1. **Levels, no cycles at any granularity.** Every production file belongs to a module of one kind, and kinds have
   levels: contract (0), core (1), application (2), adapter (3), composition root (4). A module may import only
   lower levels, plus same-level modules that the manifest orders explicitly. The declared module graph is a DAG;
   existing back edges live only in the baseline.
2. **Nothing runs across modules at load.** A module's top-level code may evaluate literals, its own module's
   declarations, and values from contract and core modules. It may not call or read a value from an application,
   adapter or another domain's module at load. Registration, wiring and caching happen when the composition root
   calls the module.
3. **Effects are capabilities.** Code above the core reaches durable I/O, the clock, randomness, IDs, environment and
   logging only through parameters it was handed: a capability record typed by narrow interfaces declared in a
   contract. Only adapters implement them and only composition roots construct them.
4. **Registrations are declared values.** A module's effect on the shared runtime (routes and operation descriptors,
   events, queues, DBOS workflows, permission catalogue entries, projections, scheduled work) is returned as data from
   one definition, validated by the composition root before anything mounts, and started through a function that
   returns its disposer.
5. **A module is verified alone.** Each module has tests that run under an import fence loading only the module and its
   declared dependencies' public entries, with fakes for its ports and a fixed clock. An adapter's tests use only its
   own schema.

### Effects

Three classes, each with one representation:

| Class                | Examples                                                                     | Representation                                                                                                                                                                                  | Where implemented                             |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Durable I/O          | Postgres reads and writes, DBOS steps, object storage, outbound HTTP, Stripe | Port interfaces in the owning module's contract (`LibraryEntryStore`, `ReceiptLedger`), passed in a capability record; commands and durable steps returned as values where the work is deferred | Adapters (`*-store.ts`, `*.sql`, `*-work.ts`) |
| Ambient effects      | clock, random IDs, environment, logging, metrics                             | One `Ambient` capability record (`now()`, `id()`, `log`) created once by the composition root; tests pass a fixed one                                                                           | Composition root                              |
| Registration effects | routes, events, queues, workflows, catalogue entries                         | Declared values in the module definition (rule 4); started with a disposer                                                                                                                      | Composition root mounts them                  |

This is capability-passing style (Effekt) and ports and adapters (Cockburn) in plain TypeScript. The Kernel is
already halfway: 350 files take a database client as a parameter and only one imports a pool singleton. What is
missing is (a) narrow port types instead of a raw client, so a use case states what it does rather than receiving the
whole database; (b) the same discipline for ambient effects; (c) a tool rule that forbids importing effect libraries
and calling ambient globals outside adapters and composition roots.

**Decision: do not adopt Effect (TypeScript) for the Kernel or Web now.** Effect's `R` parameter is a typed coeffect
and its layers are a disciplined composition root; both are the right ideas. But adopting it means changing the return
type of every effectful function (95% of Kernel lines are effectful through their imports), adapting Elysia, DBOS and
the Reylo SQL layer, and teaching every worker a second programming model. Its production evidence is vendor-channel
testimony with no published measurements. Capability records give the visible requirement at the call site, test
substitution and composition-root construction; they lose inference of what a function may do, which the import
rules partly replace. Reopen if, after steps 1–5 of the migration, ambient-effect and adapter-import violations keep
landing despite the gate, or if a pilot in one leaf module shows a measurable gain in defects or worker time. The
choice is reversible: capability records map one-to-one onto Effect services and layers.

**Decision: do not adopt Cordis or another runtime component framework.** Hot replacement and live unloading are not
REZICS requirements, Cordis links components by global key names extended through TypeScript declaration merging on
one `Context` interface (for example `packages/timer/src/index.ts:3-7`), which is the hidden global namespace the
manifest exists to remove, and the paper itself flags nominal linking as an open problem (section 6.6). Adopt its
_discipline_ statically: declared provides and requires, registration through one primitive that returns a disposer,
cycles reported from declarations, and the core/integration decomposition of section 6.5.

### State

- **Essential state is in Postgres**, owned by one module per table family (the module's `db/<module>` directory,
  as today). Another module reads it only through the owner's port or a declared projection.
- **No module-level mutable state.** The 38 top-level `Map`/`Set` registries, 8 module-level `let` and 18 `install*`
  setters become fields of values the composition root creates per process (Out of the Tar Pit's accidental state,
  scoped). A test creates a fresh one; two kernels in one process do not share it.
- **Derived values** (bound sums, compiled schemas, SQL statements) are computed either inside the module that owns
  their inputs, from contract and core values only (allowed at load by rule 2), or lazily when the composition root
  calls the module.

### Time

- **Domain time is a value.** Use cases receive `now` from the ambient capability; cores receive it as an argument
  (already adopted for cores). The composition root injects one clock, as `architecture.md` already requires.
- **Durable time is data.** Deadlines, retention and scheduled work are stored instants processed by DBOS workflows
  declared as module registrations, not timers created at load.
- **Real time stays in adapters** where the protocol needs it (authentication expiry, rate-limit windows), behind the
  same capability so tests can still fix it. `http/kernel.ts:150` already distinguishes "trusted domain time" from real
  time; make that distinction a type.

### How modules compose

**Inside a domain.** Each domain directory splits into four manifest modules: `<domain>/contract` (types, error
classes, constants, schemas, port interfaces, operation and event descriptors), `<domain>/core` (pure rules),
`<domain>/application` (use cases over ports), `<domain>/adapters` (Elysia handlers, stores, SQL, DBOS work). The
domain's public entry is its contract plus a definition exported from the adapters (rule 4). The Kernel's platform
directories (`command`, `http`, `request`, `history`, `work`, `events`) follow the same split and import no domain
module.

**Across domains.** A domain may import another domain's _contract_ and _core_. It never imports another domain's
application or adapters. Behaviour that crosses domains goes one of two ways:

- **Port owned by the consumer, implemented by the provider.** Search needs Semantic's subject summaries: Search's
  contract declares `SubjectSummaryReader`; Semantic's adapters implement it; the composition root passes it in. The
  dependency points from Semantic's adapter to Search's contract, never between applications.
- **Integration module** (spatiotemporal paper, section 6.5). When two domains interact in both directions, the
  interaction becomes a third module that depends on both cores and contracts: `library-semantic` for the 57/15 edges
  between Library and Semantic, `access-semantic` for 26/29. Neither domain imports the other.

The simulation in "Measurements" shows the size of this work: about 400 edges change to dissolve every cross-module
file cycle, and 71 of them are the minority direction of bidirectional domain pairs.

**Declared levels between domains.** Choose and record one order of domains for the DAG, by stability (Martin's SDP):
contracts and identity first, then Access policy, Semantic, Library, Search and the presentation-facing domains. The
order lives in the manifest; a new allowed dependency against it requires an owner decision, not a snapshot.

### Registrations as declared values

Sketch (a design, not code to copy):

```ts
// <domain>/adapters/definition.ts — the only effectful entry of a domain
export const definition = defineModule({
  id: 'library',
  provides: [libraryEntryReaderKey], // ports this module implements for others
  requires: [subjectSummaryReaderKey, ambientKey, databaseKey],
  operations: [addEntryOperation, moveEntryOperation], // static descriptors (rule 6 of architecture.md)
  events: [entryAddedEvent],
  queues: [shelfMaintenanceQueue],
  start(capabilities) {
    // called by the composition root only
    const routes = mountLibraryRoutes(capabilities);
    return () => routes.dispose(); // revertible: tests and shutdown unwind it
  },
});
```

The composition root collects every definition, resolves `requires` against `provides`, rejects missing keys,
duplicate operation IDs and cycles among keys, checks descriptors, and only then calls `start`. The same validation runs
statically at landing by importing definitions without starting them, which rule 2 makes safe: a definition's module
evaluates nothing from other modules at load. Keys are typed values exported from contracts, not strings, so the
spatiotemporal paper's key-collision problem cannot arise.

### How a worker verifies a module in isolation

1. **Static, seconds.** `bun scripts/architecture.ts --changed <files>`: public entries, levels, no new cycles, no
   cross-module load-time evaluation, no ambient effects outside adapters.
2. **Typecheck of the module's level.** Contracts and cores import no `.sql` files, so their typecheck needs no
   database. Packages already have their own `tsconfig`; for domain contract and core modules, a per-module
   `tsconfig` with TypeScript project references makes the compiler reject reference cycles and check the module from
   its dependencies' declarations (<https://www.typescriptlang.org/docs/handbook/project-references.html>). Whether
   the Kernel's SQL-typed adapters can be checked without a database is unresolved (earlier report); this design does
   not depend on it.
3. **Fenced module tests.** `bun test <module>` with a preload that registers a Bun runtime plugin whose `onResolve`
   callback runs "once for each `import` or `require()` as it executes" (Bun `docs/runtime/plugins.mdx`, line 167, at
   `c643ea8`). The plugin fails the test when a file of module M resolves a production file outside M and its
   declared dependencies' public entries. This is the runtime half Packwerk lacked: zero static violations _and_ the
   module actually runs alone.
4. **Fakes and conformance.** Each port has one in-memory fake, owned by the port's module, and one conformance suite
   run against both the fake and the Postgres adapter. Applications test against fakes; adapters run the conformance
   suite against their own schema in check infrastructure.
5. **Dependents of a changed contract.** When a contract's exports change, the landing runs the fenced tests of the
   modules that import it, found from the manifest, and the brief or commit states the change in a sentence (the
   Xia et al. remedy). Because dependents' tests are fenced, this costs the dependents' modules, not the system.
6. **System proof after integration.** One boot and acceptance run on dev, as today, now expected to fail rarely.

### What the control plane enforces at landing

On the merged candidate, by exit code:

| Check                                                                 | Source of truth                                                                                                                     | Cost                                          | Refuses                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Architecture check, `--changed` (full scan when the manifest changes) | `modules.json`, baseline                                                                                                            | 10.5 s full, under 5 s budgeted cached        | new public-entry, level, cycle, load-time and ambient-effect violations; baseline growth |
| Ratchet metrics                                                       | baseline file plus four counters: largest file SCC, files in cycles, cross-module load-time initialisers, ambient-effect call sites | included                                      | any counter increase                                                                     |
| Static composition check                                              | module definitions                                                                                                                  | seconds (imports definitions, starts nothing) | missing provides, duplicate operation IDs, key cycles, descriptor errors                 |
| Fenced tests of touched modules and contract dependents               | manifest                                                                                                                            | proportional to the change                    | test failure or a fence breach                                                           |
| Typecheck of touched contract and core modules                        | per-module tsconfig                                                                                                                 | seconds                                       | type errors                                                                              |

Prompts carry the module map (already generated by `--map`) and, for the brief's module, its contract file list. A
worker that needs a new allowed dependency against the declared order asks the module owner through the inbox; the
landing does not accept a manifest edit that adds a back edge.

### Web

The same paradigm, with the Web's own adapters. Pure view models, formatters and validation are cores (some already
are: `search/personal-recovery`, `subject-catalogue-metadata`). Data access is an adapter: TanStack Router loaders and
TanStack Query functions over the generated client, injected through route context rather than imported clients
(85 Web files call `fetch(` directly; 101 call `Date.now()`/`new Date()`). Components receive data and callbacks by
props and import only their feature's public entry, shared UI packages and cores. Routes are already declared values
(file routes); each feature exports one definition of its routes, loaders and query keys. The largest Web cycle (82
files, 78 in `features`) and the 24-of-28 directory cycle are smaller and mostly intra-feature, so the Web migration
is the same ratchet at lower cost. Storybook stories are the Web's fenced module tests: a story that renders a
feature with fake loaders is its isolation proof.

## Migration under a ratchet

Each step is a sequence of ordinary briefs that agents carry out module by module. Each step adds a rule to the
checker with a baseline of today's violations, so new violations stop at once and old ones shrink as briefs land. The
order is by the measured cost each step removes, cheapest decisive step first.

**Step 1. Gate the existing check (stops the growth).** Wire `bun scripts/architecture.ts --changed` into the landing
of every candidate and into `worker-check`, by exit code; add the module map to every prompt. Before wiring, reseed
the baseline once from the current revision so the gate starts green, with the 1,014 new entries grouped by owner.
_Cost removed:_ about 65 new violations an hour, including about 17 new value-cycle edges an hour (268 in 15.6
hours), which are the raw material of boot failures. _Done when:_ a candidate that adds a rule 2 or rule 3 violation
is refused, and the baseline only shrinks.

**Step 2. Make the declared graph acyclic and the modules fine-grained.** Replace snapshotted `allowedDependencies`
with the declared domain order; move every back edge into the baseline. Split each Kernel domain module into
contract, core, application and adapter modules by path (initially by a path convention, for example
`<domain>/contract/**`, with existing files assigned to `adapters` until moved). _Cost removed:_ 18 modules on
allowed cycles become zero by declaration; rule 2 starts seeing intra-domain deep imports. No product code changes.

**Step 3. Forbid cross-module evaluation at load (removes the boot-failure class).** New checker rule: a top-level
initialiser may not call or read an imported binding from a module other than its own, its domain's contract or core,
or a package of kind contract or core. Baseline today's 197 initialisers in 108 files; briefs move each into its
owner's contract (constants, bound sums) or behind the module's `start` (registries, compiled statements). _Cost
removed:_ the mechanism of all five boot failures named in the brief. After this step a new cycle is a structural debt
but no longer a crash, so dev boots even while cycles remain.

**Step 4. Registrations as declared values (removes the boot-only conflict class).** Introduce `defineModule` in the
platform contract and the static composition check. Convert `modules?: ((app) => void)[]` mounting, event catalogue
entries, queue registration and permission catalogue contributions one module at a time; the composition root accepts
both forms until the last module moves, then the old form is deleted. _Cost removed:_ route, security and catalogue
conflicts found at landing in seconds instead of at `createKernel`; 38 top-level registries and 18 `install*` setters
lose their reason to exist.

**Step 5. Ambient effects as capabilities.** Checker rule: `Date.now`, `new Date()` without arguments,
`Math.random`, `crypto.randomUUID`, `process.env` and effect-library imports are allowed only in adapters and
composition roots. Baseline 257 + 81 + 14 files; briefs thread the `Ambient` capability through use cases. _Cost
removed:_ flaky time-dependent tests and the need for a running system to control time; applications become testable
with fakes.

**Step 6. Invert cross-domain behaviour edges (dissolves the cycle).** In the order the simulation gives: (a) make
platform directories domain-free (155 edges), (b) move vocabulary to domain contracts (176 edges), (c) introduce
consumer-owned ports or integration modules for the 12 bidirectional domain pairs (71 minority edges first), then
the remaining back edges against the declared order. Each brief takes one module pair and must reduce the largest-SCC
counter. _Cost removed:_ the 387-file SCC; the median closure of 610 files falls toward the size of a domain plus
contracts. The simulation's endpoint is no cross-module file cycle, with intra-library cycles of 65 files left for the
owner.

**Step 7. Fenced module tests as the landing's runtime proof.** Add the import-fence preload and per-module test
entries; land them per module as soon as that module's closure fits its declared dependencies. Switch affected-test
selection at landing to manifest dependents of touched modules. _Cost removed:_ whole-system test runs for ordinary
changes; 71% of test files currently load the giant cycle.

Steps 1–3 can start the same day and are independent. Step 4 and step 5 run in parallel per module. Step 6 is the
long tail, owned by domain Goals with a standing share of capacity, gated by the counters. Step 7 follows step 6
module by module.

**Ratchet counters**, all computed by the checker and printed in the landing record:

| Counter                                    |                      Today | Must                            |
| ------------------------------------------ | -------------------------: | ------------------------------- |
| Baseline entries                           | 9,714 (+1,014 unbaselined) | only shrink                     |
| Largest Kernel value SCC (files)           |                        387 | not grow; target 0 cross-module |
| Kernel files in value cycles               |                        404 | not grow                        |
| Cross-module top-level initialisers        |                        197 | not grow; target 0              |
| Ambient-effect call sites outside adapters |        257 / 81 / 14 files | not grow                        |
| Manifest modules on allowed cycles         |                         18 | 0 after step 2                  |
| Median Kernel transitive closure (files)   |                        610 | report; target under 150        |

## Prices

Lines are estimates from the measured counts (files × typical edit), not from trial edits. "Throughput" means
accepted landings per worker-hour across the fleet; the estimates are judgments derived as stated and are marked
unverified in the next section.

| Step                                    | Lines touched                                                                                                     | Risk                                                                                                                                                                                 | Expected throughput change                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Gate the check                       | 100–300 in `tools/goal` and `scripts`; baseline regenerated                                                       | Low. Main risk: refusals. Files with new violations were touched by 505 of the 2,145 commits since seeding (24%), an upper bound on initial refusals; most fixes are one import line | Short term −5% to −15% while workers learn the map (refusals cost one fix round each). Medium term positive: new cycles stop, so the boot failures and cycle repairs they cause stop growing (222 cycle- or initialisation-related commit subjects since 10-25) |
| 2. Acyclic declared graph, fine modules | 500–1,500 in `modules.json` and the checker; no product code                                                      | Low. A badly chosen domain order causes many baseline entries, which is cosmetic                                                                                                     | Neutral directly; enables steps 3–7 and makes rule 2 meaningful inside domains                                                                                                                                                                                  |
| 3. No cross-module load-time evaluation | 1,500–3,000 across 108 files                                                                                      | Medium. Moving initialisers changes when values are computed; each brief proves its module still loads with the fence or a targeted import test                                      | High. Each boot failure stalls every worker that needs a booting dev to verify (all 30) until repaired; five such failures are named in the brief. Removing the class removes those stalls; size depends on stall duration, not measured here                   |
| 4. Registrations as declared values     | 4,000–8,000 (one definition per domain plus composition root and checker)                                         | Medium. Two registration forms coexist during migration; the composition root must accept both                                                                                       | Positive. Conflicts found in seconds at landing instead of blocking unrelated tasks at `createKernel` (the earlier report traces one such block)                                                                                                                |
| 5. Ambient effects as capabilities      | 3,000–6,000 across about 330 files                                                                                | Low to medium. Mechanical threading; risk of mixing domain time and real time, mitigated by distinct types                                                                           | Small positive: fewer time-dependent flaky tests and fewer tests needing the system to control time                                                                                                                                                             |
| 6. Invert cross-domain edges            | 15,000–40,000 over weeks: about 400 edges, each needing a port, a moved type or an integration module, plus tests | High per edge, low per brief: each brief is one module pair, gated by the SCC counter                                                                                                | Largest long-term gain. Test closure falls from half the Kernel to a domain; affected-test selection becomes meaningful; parallel briefs in different domains stop colliding through shared hubs                                                                |
| 7. Fenced module tests                  | 2,000–5,000 (preload, per-module entries, fakes and conformance suites) on top of step 6                          | Low. The fence can be enabled per module                                                                                                                                             | High for verification cost: a worker verifies its module in seconds to minutes without a stack. The landing runs fenced tests of touched modules and contract dependents instead of whole-system suites                                                         |
| Not adopting Effect                     | 0 now; a full adoption would touch most of the 405,370 Kernel lines                                               | —                                                                                                                                                                                    | Avoids a fleet-wide learning cost whose benefit is unmeasured                                                                                                                                                                                                   |

**Order by cost removed per line.** Step 1 removes the growth at the lowest price. Step 3 removes the most severe
failure class (boot) for a few thousand lines. Step 4 removes the next blocking class (composition conflicts). Step 6 is
the largest and slowest and is what turns the rules into isolation; step 7 harvests it. Step 2 costs no product code
and is a precondition, so it runs immediately with step 1.

**What would prove this wrong.** If after steps 1–3 boot failures recur at a similar rate, the failure is not load-time
evaluation and the cause must be re-traced. If after step 6 in one domain its fenced tests still need most of the
Kernel, the port inversion is leaking (likely through contract modules that grew behaviour). If refusals stay above
10% of landings after two weeks, the module map in prompts is not reaching workers or the declared order is wrong.

## Unverified claims

- Throughput estimates in "Prices" are judgments, not measurements. Boot-failure stall durations and refusal rates
  after gating were not measured; the 24% figure is an upper bound from files touched, not from violations
  introduced.
- Line estimates are derived from counts, not trial edits.
- The edge-removal simulations classify imported names by regular expressions (names ending in `Error` or `Schema`,
  all-capital constants, `type` specifiers). Some "behaviour" specifiers may be vocabulary and the reverse.
- The top-level initialiser and ambient-effect counts use line-anchored patterns and miss multi-line forms.
- The brief's figures (358 files in runtime cycles, largest 322 across seven domains, 1,008 violations) differ from
  this revision's (404, 387 across 14 top-level directories, 1,014). They were measured at another revision and
  probably with a different cycle definition; this report uses its own measurements throughout.
- Claim Plane was read from its abstract only; its full text could not be extracted.
- Paraphrased claims from Lakos (1996), Martin (2000, 2002), Baldwin and Clark (2000), Winters et al. (2020), Potvin
  and Levenberg (2016), Ananthanarayanan et al. (2019), Dijkstra (1968), MacCormack et al. (2012), Cataldo et al.
  (2006), Moseley and Marks (2006) and Parnas (1979) are from the works as known to the author and were not re-read
  for this report; the quotations from Parnas (1972), Conway (1968), Cockburn (2005) and Martin's principle names are
  standard but were not re-checked against the original pages.
- The author order of _Capturing Types_ was not checked against the publisher's page.
- Effect production benefits are as stated by guests on Effect's own podcast; no independent case study was found.
- The Bun runtime plugin was read in documentation only; whether an `onResolve` fence covers every import form the
  Kernel uses (dynamic `import()`, `.sql` imports, workspace exports) was not tried.
- The claim that a per-module TypeScript project-reference build of contract and core modules needs no database
  follows from those modules importing no `.sql` files; it was not run.

## Sources

Effect systems and composability

- Yifan Shi, Wei Zhang, Tianyi Cui. _A Programming Paradigm for Spatiotemporal Composability._ arXiv:2608.25512 v1, 2026. <https://arxiv.org/abs/2608.25512>. arXiv non-exclusive distribution licence. Implementation: Cordis,
  <https://github.com/cordiverse/cordis>, MIT, commit `66633488b4964857e66f3f618cd57a6bb7068da0`.
- John M. Lucassen, David K. Gifford. _Polymorphic Effect Systems._ POPL 1988. <https://doi.org/10.1145/73560.73564>
- Gordon Plotkin, John Power. _Algebraic Operations and Generic Effects._ Applied Categorical Structures, 2003.
  <https://doi.org/10.1023/A:1023064908962>
- Gordon Plotkin, Matija Pretnar. _Handlers of Algebraic Effects._ ESOP 2009.
  <https://doi.org/10.1007/978-3-642-00590-9_7>
- Daan Leijen. _Koka: Programming with Row Polymorphic Effect Types._ MSFP 2014.
  <https://doi.org/10.4204/EPTCS.153.8>
- Daan Leijen. _Type Directed Compilation of Row-Typed Algebraic Effects._ POPL 2017.
  <https://doi.org/10.1145/3009837.3009872>
- Jonathan Immanuel Brachthäuser, Philipp Schuster, Klaus Ostermann. _Effects as Capabilities: Effect Handlers and
  Lightweight Effect Polymorphism._ OOPSLA 2020. <https://doi.org/10.1145/3428194>
- Aleksander Boruch-Gruszecki, Martin Odersky, Edward Lee, Ondřej Lhoták, Jonathan Brachthäuser. _Capturing Types._
  ACM TOPLAS, 2023. <https://doi.org/10.1145/3618003>
- Mark S. Miller. _Robust Composition: Towards a Unified Approach to Access Control and Concurrency Control._ PhD
  thesis, Johns Hopkins University, 2006. <http://www.erights.org/talks/thesis/>
- Tomas Petricek, Dominic Orchard, Alan Mycroft. _Coeffects: A Calculus of Context-Dependent Computation._ ICFP 2014.
  <https://doi.org/10.1145/2628136.2628160>
- KC Sivaramakrishnan, Stephen Dolan, Leo White, Tom Kelly, Sadiq Jaffer, Anil Madhavapeddy. _Retrofitting Effect
  Handlers onto OCaml._ PLDI 2021. <https://doi.org/10.1145/3453483.3454039>
- Effect-TS contributors. _Effect_ 4.1.2. <https://github.com/Effect-TS/effect>, MIT, commit
  `cb679e39cabeeadc5b40a5e20da311b9e4054a1b`; documentation <https://effect.website/>.
- Effect. _Cause & Effect_ podcast, episodes 1–8, 2024–2026. <https://effect.website/podcast/>; Zendesk episode:
  <https://effect.website/podcast/episodes/adopting-effect-at-zendesk-with-attila-vecerek/>

Classic architecture

- David L. Parnas. _On the Criteria To Be Used in Decomposing Systems into Modules._ CACM 15(12), 1972.
  <https://doi.org/10.1145/361598.361623>
- David L. Parnas. _Designing Software for Ease of Extension and Contraction._ IEEE TSE SE-5(2), 1979.
  <https://doi.org/10.1109/TSE.1979.234169>
- Edsger W. Dijkstra. _The Structure of the "THE"-Multiprogramming System._ CACM 11(5), 1968.
  <https://doi.org/10.1145/363095.363143>
- Melvin E. Conway. _How Do Committees Invent?_ Datamation 14(4), 1968.
  <https://www.melconway.com/Home/Committees_Paper.html>
- Alan MacCormack, Carliss Baldwin, John Rusnak. _Exploring the Duality between Product and Organizational
  Architectures: A Test of the "Mirroring" Hypothesis._ Research Policy 41(8), 2012.
  <https://doi.org/10.1016/j.respol.2012.04.011>
- Marcelo Cataldo, Patrick Wagstrom, James Herbsleb, Kathleen Carley. _Identification of Coordination Requirements._
  CSCW 2006. <https://doi.org/10.1145/1180875.1180929>
- Carliss Baldwin, Kim Clark. _Design Rules, Volume 1: The Power of Modularity._ MIT Press, 2000.
  <https://mitpress.mit.edu/9780262024662/>
- John Lakos. _Large-Scale C++ Software Design._ Addison-Wesley, 1996. ISBN 0-201-63362-0.
- Robert C. Martin. _Design Principles and Design Patterns._ Object Mentor, 2000.
  <https://web.archive.org/web/20150906155800/http://www.objectmentor.com/resources/articles/Principles_and_Patterns.pdf>
- Robert C. Martin. _Agile Software Development: Principles, Patterns, and Practices._ Prentice Hall, 2002.
- Alistair Cockburn. _Hexagonal Architecture._ 2005. <https://alistair.cockburn.us/hexagonal-architecture/>
- Gary Bernhardt. _Boundaries._ SCNA 2012. <https://www.destroyallsoftware.com/talks/boundaries>; _Functional Core,
  Imperative Shell_, 2012. <https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell>
- Ben Moseley, Peter Marks. _Out of the Tar Pit._ 2006. <https://curtclifton.net/papers/MoseleyMarks06a.pdf>
- Ecma International. _ECMAScript Language Specification (ECMA-262)_, Cyclic Module Records.
  <https://tc39.es/ecma262/#sec-cyclic-module-records>

Many writers in parallel

- Rachel Potvin, Josh Levenberg. _Why Google Stores Billions of Lines of Code in a Single Repository._ CACM 59(7), 2016. <https://doi.org/10.1145/2854146>
- Titus Winters, Tom Manshreck, Hyrum Wright. _Software Engineering at Google._ O'Reilly, 2020, chapter 18.
  <https://abseil.io/resources/swe-book>
- Bazel. _Visibility._ <https://bazel.build/concepts/visibility>
- Sundaram Ananthanarayanan et al. _Keeping Master Green at Scale._ EuroSys 2019.
  <https://doi.org/10.1145/3302424.3303970>
- Maple Ong. _Enforcing Modularity in Rails Apps with Packwerk._ Shopify Engineering, 2020.
  <https://shopify.engineering/enforcing-modularity-rails-apps-packwerk>
- Gannon McGibbon, Chris Salzberg. _A Packwerk Retrospective._ Shopify Engineering, 2024.
  <https://shopify.engineering/a-packwerk-retrospective>. Packwerk: <https://github.com/Shopify/packwerk>, MIT, commit
  `31e534283f93a225b520cddab3c2d735557c76de`.
- Haocheng Xia, Eugene Wu, Yongjoo Park. _Passes Alone, Fails Together: Benchmarking Semantic Coordination in Parallel
  LLM-Agent Development._ arXiv:2609.25396, 2026. <https://arxiv.org/abs/2609.25396>
- Maxim Nikolaev. _Claim Plane: Reliability Gains and the Limits of Selective Concurrency for Parallel Coding Agents._
  arXiv:2608.00947, 2026. <https://arxiv.org/abs/2608.00947>
- Zetong Xiong et al. _BulkPR-Bench: Benchmarking Queue-Level Governance of Interacting Pull Requests._
  arXiv:2608.02685, 2026. <https://arxiv.org/abs/2608.02685>
- George Xu, Arjun Subramanian, Nithilan Karthik. _AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge
  Conflict Rates._ arXiv:2607.04697, 2026. <https://arxiv.org/abs/2607.04697>

Tools

- TypeScript. _Project References._ <https://www.typescriptlang.org/docs/handbook/project-references.html>
- Bun. _Plugins_ (runtime `onResolve`), `docs/runtime/plugins.mdx`, <https://github.com/oven-sh/bun>, MIT, commit
  `c643ea8c2a9da88cae7e3508d2dd95c8f5857926`.

Repository

- [Architecture principles](../architecture.md); [architecture check](../architecture/README.md);
  `scripts/architecture.ts`; `docs/architecture/modules.json`; `docs/architecture/boundary-baseline.json`.
- [Engineering modularity (Opus 5.5)](engineering-modularity-opus-5-5.md);
  [engineering modularity (GPT-6 Astra)](engineering-modularity-gpt-6-astra.md).
