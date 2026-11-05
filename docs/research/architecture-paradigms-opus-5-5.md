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

Citations give title, authors, year and link; the full list is under "Sources". Quotations are verbatim from the
source read; paraphrases are marked as such. Clones used: Effect (TypeScript) `cb679e3`, MIT; Packwerk `31e5342`, MIT;
Cordis `6663348`, MIT; Bun `c643ea8`, MIT. All are recorded in `.reference/INDEX.md` under `architecture-paradigms` or
`search-worker-outcome-harness`.

### Spatiotemporal composability

*A Programming Paradigm for Spatiotemporal Composability*, Yifan Shi, Wei Zhang and Tianyi Cui (Peking University;
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
   *and* its inverse, and inverses compose in reverse order. In Cordis every context mutation goes through one
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
   paper's remedy is decomposition: a server and an access controller that call each other become *server-core*,
   *access-control-core*, *request-mediation* and *policy-management*; "neither core depends on the other; only the
   integration components depend on both." The cost is more components, up to quadratic in mutually interacting
   components, which it proposes to mitigate with bundling, convention-based wiring and scaffolding.
5. **Limits it states.** Linking is nominal by key name, so interface drift and key collisions are possible across
   independently built components (section 6.6). The Koishi case study (section 5.3: a chatbot framework with "over
   4000 community-contributed plugins") is "an existence-and-adoption result rather than a quantitative one";
   overhead and productivity against a baseline are future work. Effects that leave the system boundary (bytes
   written, messages sent) cannot be reverted, only withheld or compensated (section 6.1).

For REZICS the relevant part is not hot reload. It is that a component's whole effect on its environment and its whole
dependence on it are *declared values* that a runtime, or a static check, can inspect. The paper's section 6.5
example is our own failure: the `IDEMPOTENCY_HEADER` boot failure was a cycle between HTTP problem mapping and Access.

### Effect systems in theory and practice

- **Effect systems.** *Polymorphic Effect Systems*, John M. Lucassen and David K. Gifford, POPL 1988
  (<https://doi.org/10.1145/73560.73564>): types annotated with the effects a computation may have, originally to find
  what can run in parallel. That motivation is ours: knowing what code touches tells you what can be changed and
  checked independently.
- **Algebraic effects and handlers.** *Algebraic Operations and Generic Effects*, Gordon Plotkin and John Power, 2003
  (<https://doi.org/10.1023/A:1023064908962>), and *Handlers of Algebraic Effects*, Gordon Plotkin and Matija Pretnar,
  ESOP 2009 (<https://doi.org/10.1007/978-3-642-00590-9_7>). An effect is an interface of operations; a handler gives
  it meaning; the same code runs under a production handler or a test handler. This is ports and adapters stated as
  semantics (paraphrase).
- **Koka.** *Koka: Programming with Row Polymorphic Effect Types*, Daan Leijen, MSFP 2014
  (<https://doi.org/10.4204/EPTCS.153.8>), and *Type Directed Compilation of Row-Typed Algebraic Effects*, Daan Leijen,
  POPL 2017 (<https://doi.org/10.1145/3009837.3009872>). Every function's type carries an inferred row of effects;
  a function with an empty row is pure. The key practical property is inference: the programmer does not write the
  rows, the compiler reports them.
- **Effekt and capability passing.** *Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism*,
  Jonathan Immanuel Brachthäuser, Philipp Schuster and Klaus Ostermann, OOPSLA 2020
  (<https://doi.org/10.1145/3428194>). Effect types are read as the capabilities a computation needs from its
  context; handlers are passed explicitly (capability-passing style) and functions are second class to keep
  capabilities from escaping. The authors trade some purity reasoning for much simpler effect polymorphism and
  encapsulation (paraphrase of the abstract). *Capturing Types*, Aleksander Boruch-Gruszecki, Martin Odersky, Edward
  Lee, Ondřej Lhoták and Jonathan Brachthäuser, ACM TOPLAS 2023 (<https://doi.org/10.1145/3618003>), brings the
  same idea to Scala as capture checking. Object capabilities in general: *Robust Composition*, Mark S. Miller, PhD
  thesis, Johns Hopkins University, 2006 (<http://www.erights.org/talks/thesis/>): authority flows only through
  references you were given.
- **Coeffects.** *Coeffects: A Calculus of Context-Dependent Computation*, Tomas Petricek, Dominic Orchard and Alan
  Mycroft, ICFP 2014 (<https://doi.org/10.1145/2628136.2628160>): the dual of effects, tracking what a computation
  *requires* from its context. The spatiotemporal paper builds its spatial dimension on this.
- **Effect handlers in a production language.** *Retrofitting Effect Handlers onto OCaml*, KC Sivaramakrishnan,
  Stephen Dolan, Leo White, Tom Kelly, Sadiq Jaffer and Anil Madhavapeddy, PLDI 2021
  (<https://doi.org/10.1145/3453483.3454039>). OCaml 5 ships untyped handlers; effects are not in function types.
  This shows the industrial compromise: the runtime mechanism shipped, the static effect tracking did not.
- **Effect (TypeScript).** Effect-TS/effect `cb679e3`, package `effect` 4.1.2, MIT. `Effect<A, E, R>` is "a value that
  lazily describes a workflow or job. The workflow requires some context `R`, and may fail with an error of type `E`"
  (`packages/effect/src/Effect.ts:98-100`). "A `Layer<ROut, E, RIn>` describes how to acquire one or more services,
  which services are required to build them, and which errors can occur during acquisition"
  (`packages/effect/src/Layer.ts:4-6`). Test services such as `testing/TestClock.ts` replace time. `R` is a
  compile-time coeffect: a program that still requires a service does not type-check as runnable. Production evidence
  is from Effect's own podcast, *Cause & Effect* (<https://effect.website/podcast/>): Zendesk ("one of their main
  products, serving millions of users every day", episode 1, 2024-11-26; the guest credits dependency injection,
  layers and an incentive to write unit tests), Markprompt, MasterClass, Vercel, Spiko, OpenRouter, Warp and OpenCode
  (episode 8, 2026-06-19, migrating "a large TypeScript codebase to Effect"). These are testimonials from the
  vendor's channel. No controlled study or published defect or throughput numbers were found.

**What practice shows.** Typed effect tracking (Koka rows, Effekt capabilities, Effect's `R`) works when the compiler
infers or checks it on every edit. Where the language cannot, systems keep the *runtime* half (handlers, layers,
disposers) and enforce the static half with conventions and tools (OCaml 5, Cordis, plain dependency injection). For
TypeScript the choice is between (a) adopting a library whose types carry requirements, which rewrites every effectful
signature, and (b) passing capability records explicitly and checking imports, which keeps signatures but gives up
inference of what a function may do.

### Classic architecture literature

- **Parnas, decomposition criteria.** *On the Criteria To Be Used in Decomposing Systems into Modules*, David L. Parnas,
  CACM 1972 (<https://doi.org/10.1145/361598.361623>): "We propose instead that one begins with a list of difficult
  design decisions or design decisions which are likely to change. Each module is then designed to hide such a
  decision from the others." Decomposing by processing steps, as a flowchart, couples every module to shared
  representations. *Designing Software for Ease of Extension and Contraction*, David L. Parnas, IEEE TSE 1979
  (<https://doi.org/10.1109/TSE.1979.234169>), adds the *uses* relation: when it is loop-free, every level is a usable
  and testable subset of the system; when it loops, "nothing works until everything works" (paraphrase).
- **Dijkstra, THE.** *The Structure of the "THE"-Multiprogramming System*, Edsger W. Dijkstra, CACM 1968
  (<https://doi.org/10.1145/363095.363143>). Six layers, each using only those below. The paper credits the hierarchy
  for making exhaustive testing of each level feasible before the next was added (paraphrase).
- **Conway.** *How Do Committees Invent?*, Melvin E. Conway, Datamation 1968
  (<https://www.melconway.com/Home/Committees_Paper.html>): "organizations which design systems ... are constrained
  to produce designs which are copies of the communication structures of these organizations." Empirical test:
  *Exploring the Duality between Product and Organizational Architectures: A Test of the "Mirroring" Hypothesis*,
  Alan MacCormack, Carliss Baldwin and John Rusnak, Research Policy 2012
  (<https://doi.org/10.1016/j.respol.2012.04.011>): loosely coupled organisations (open source) produced
  significantly more modular products than tightly coupled ones (paraphrase). *Identification of Coordination
  Requirements*, Marcelo Cataldo, Patrick Wagstrom, James Herbsleb and Kathleen Carley, CSCW 2006
  (<https://doi.org/10.1145/1180875.1180929>): changes are completed faster when coordination matches the
  dependencies among the work (paraphrase).
- **Baldwin and Clark, design rules.** *Design Rules, Volume 1: The Power of Modularity*, Carliss Baldwin and Kim
  Clark, MIT Press 2000 (<https://mitpress.mit.edu/9780262024662/>). Parallel independent work becomes possible when
  a small set of *visible design rules* (architecture, interfaces, tests) is fixed first and everything else is hidden
  in modules (paraphrase).
- **Lakos, levelization.** *Large-Scale C++ Software Design*, John Lakos, Addison-Wesley 1996 (ISBN 0-201-63362-0).
  Physical design: components get a *level* (1 + the highest level they depend on); a system is levelizable only if
  its component dependency graph is acyclic; cyclic physical dependencies defeat understanding, testing and reuse
  because no part can be tested without the rest. He measures coupling with cumulative component dependency (CCD), the
  sum over components of the number of components each needs to be tested (paraphrase). Our median closure of 610
  files is that measure per file.
- **Martin, package principles.** *Design Principles and Design Patterns*, Robert C. Martin, 2000
  (<https://web.archive.org/web/20150906155800/http://www.objectmentor.com/resources/articles/Principles_and_Patterns.pdf>),
  and *Agile Software Development: Principles, Patterns, and Practices*, Prentice Hall 2002. Acyclic dependencies
  principle: "Allow no cycles in the package dependency graph." Stable dependencies principle: "Depend in the
  direction of stability." Stable abstractions principle: a package should be as abstract as it is stable. Cycles are
  broken by dependency inversion: the depended-on side declares an interface the other implements.
- **Cockburn, ports and adapters.** *Hexagonal Architecture*, Alistair Cockburn, 2005
  (<https://alistair.cockburn.us/hexagonal-architecture/>): "Allow an application to equally be driven by users,
  programs, automated test or batch scripts, and to be developed and tested in isolation from its eventual run-time
  devices and databases."
- **Functional core, imperative shell.** Gary Bernhardt, *Boundaries*, SCNA 2012
  (<https://www.destroyallsoftware.com/talks/boundaries>), and the screencast *Functional Core, Imperative Shell*,
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

- **Google.** *Why Google Stores Billions of Lines of Code in a Single Repository*, Rachel Potvin and Josh Levenberg,
  CACM 2016 (<https://doi.org/10.1145/2854146>): one trunk with tens of thousands of engineers works because of build
  tooling that knows every dependency and tests affected targets (paraphrase). *Software Engineering at Google*, Titus
  Winters, Tom Manshreck and Hyrum Wright, O'Reilly 2020, chapter 18 (<https://abseil.io/resources/swe-book>):
  fine-grained modules, the "1:1:1" rule (one directory, one package, one build target) and visibility restrictions
  keep the build graph explicit (paraphrase). Bazel enforces it: a target may only be depended on by packages its
  `visibility` lists (<https://bazel.build/concepts/visibility>).
- **Uber.** *Keeping Master Green at Scale*, Sundaram Ananthanarayanan et al., EuroSys 2019
  (<https://doi.org/10.1145/3302424.3303970>): with hundreds of changes a day, a submit queue that builds and tests
  candidate changes speculatively, using the build graph to find independent changes, keeps trunk green; conflict
  analysis relies on target-level dependencies (paraphrase).
- **Shopify.** *Enforcing Modularity in Rails Apps with Packwerk*, Maple Ong, 2020-09-23
  (<https://shopify.engineering/enforcing-modularity-rails-apps-packwerk>), and *A Packwerk Retrospective*, Gannon
  McGibbon and Chris Salzberg, 2024-02-07 (<https://shopify.engineering/a-packwerk-retrospective>). Packwerk kept a
  "deprecated references list" as a ratchet, like our baseline. The retrospective's findings: dependency checks
  provided "value in holding the line against new dependencies at the base layer"; privacy checks turned Packwerk into
  "an API design tool" and were removed in v3.0. A package brought to zero violations still would not boot in
  isolation, because constants loaded outside the tracked mechanism are "untracked and invisible to the tool", so "a
  package that is well-defined according to Packwerk (has no violations left to resolve) may actually crash with name
  errors when its code is executed." Their conclusion: "running code, more than any metric, will always be the best
  indicator of real progress."
- **Semantic interference between parallel agents.** *Passes Alone, Fails Together: Benchmarking Semantic Coordination
  in Parallel LLM-Agent Development*, Haocheng Xia, Eugene Wu and Yongjoo Park, arXiv:2609.25396, 2026-09-21
  (<https://arxiv.org/abs/2609.25396>). On constructed interface changes to 12 Django helpers, 105 of 108 blind
  GPT-5.5 runs (97%) produced patches that each passed alone but failed when merged, despite clean textual merges.
  A roughly 130-token description of the completed interface change recovered 82% (in the synthetic tier it cut
  interference from 2.50 to 0.04 per run). On 417 mined Django PR pairs, interference was rare (1 of 834 runs), which
  the authors attribute to history that review had already reconciled. "This happens when one agent changes an
  interface or rule that another agent still relies on." The authors warn that the constructed rates do not estimate
  real frequency.
- **Pre-write admission.** *Claim Plane: Reliability Gains and the Limits of Selective Concurrency for Parallel Coding
  Agents*, Maxim Nikolaev, arXiv:2608.00947, 2026-08-02 (<https://arxiv.org/abs/2608.00947>; abstract only, the full
  text could not be extracted). On 30 CooperBench feature pairs, static admission over declared change scopes raised
  pair pass from 23.3% to 50.0% and integration success from 65.6% to 96.7%, but it "recovered reliability largely by
  collapsing toward serial execution" (96.7% of executions serialised). Dynamic admission failed closed on undeclared
  scope in 46 of 90 executions.
- **Queue governance.** *BulkPR-Bench: Benchmarking Queue-Level Governance of Interacting Pull Requests*, Zetong Xiong
  et al. (23 authors, Baidu), arXiv:2608.02685, 2026-08-03 (<https://arxiv.org/abs/2608.02685>). Six current models
  selecting safe merge subsets from 581 candidate PRs in 18 repositories completed only 8 of 324 queues exactly; unsafe
  merges occurred in 226 runs; agents respected 98–100% of the relations they recovered, so the gap is *recovering*
  relations, and supplying the relation graph raised scores to 77.5–99.1%.
- **Context only.** *AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates*, George Xu,
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

| Idea | Agents closing cycles | Cross-module computation at load | Effects everywhere | Whole-system verification |
| --- | --- | --- | --- | --- |
| Parnas 1972 (information hiding) | A worker imports the file that has the function it needs because nothing marks it as a hidden decision; modules split by feature journey, the flowchart decomposition Parnas warns against, so every journey touches shared representations | Load-time computation exposes a module's internal representation (bounds sums, schemas) as a dependency of others' initialisation | Effects are design decisions likely to change (database, DBOS, Elysia); unhidden, every module depends on them | A module whose secrets are not hidden cannot be tested against its interface |
| Parnas 1979 (loop-free *uses*) | Predicts exactly "nothing works until everything works": one loop and no subset is testable | Initialisation order is a *uses* relation at load time; a loop makes it undefined | — | Loop-free *uses* is the precondition for testing subsets; we have none |
| Dijkstra THE (layers) | A layer may use only those below; a cycle is a layering violation by definition | Layers initialise bottom-up; cross-layer initialisation is impossible by construction | Effects belong to designated layers | Each layer is verified before the next exists; we verify only the whole |
| Conway / mirroring | Domain modules mirror Goals (0.80–0.98 owner share, earlier report); infrastructure has no owner and the most writers, so it becomes the cycle's hub (`command.ts` receives 219 SCC edges) | — | — | Workers that do not communicate produce modules that only meet at boot |
| Lakos (levelization, CCD) | A cycle merges all its members into one level; CCD jumps | Static initialisation across components is the classic C++ "static initialisation order fiasco"; the same class appears here as TDZ | — | CCD ≈ test cost: median closure 610 files means each test needs half the Kernel |
| Martin (ADP, SDP, SAP) | Cycles break ADP; infrastructure (most depended on, should be most stable) imports volatile domain code, breaking SDP | Concrete computation in stable modules breaks SAP | — | Fix by inversion: the stable side declares an interface |
| Ports and adapters | — | — | Business rules call effects directly instead of through ports; 4.7% effect-free | Predicts our state: without ports, tests need the real database (713 test files) |
| Functional core / imperative shell | — | Load-time computation is shell work done at import | Predicts that decisions are tested only through I/O | A pure core would be testable by values, in milliseconds |
| Out of the Tar Pit | — | Module-level registries and caches are accidental state with global reach (38 top-level maps, 18 `install*` setters) | Control and state woven through logic are the main source of complexity | Tests must reconstruct all accidental state, hence `createKernel` in 350 tests |
| Effect systems (Koka, Effekt, Effect) | — | — | An effect type or capability makes effects visible in signatures; absent that, any call may do anything and agents cannot know | Handlers or layers substitute test implementations; requires effects to be reachable only through them |
| Coeffects / spatiotemporal composability | Requirements declared as keys make cycles "predictable from the dependency declarations alone" | Registrations as `ctx.effect` values with inverses replace import-time side effects | Every interaction goes through one context, so it can be observed and faked | A component can be loaded alone with its declared requirements satisfied by test providers, and unloaded cleanly |
| Packwerk retrospective | Dependency checks hold the line on new edges | Untracked load mechanisms let a "clean" package crash at run time | — | Zero static violations did not make a package boot alone; only running it in isolation proves isolation |
| Recent agent studies | Agents respect the relations they can see (98–100%, BulkPR-Bench) and miss the ones they cannot | — | — | Agents' changes pass alone and fail together when an interface changes silently (97% in constructed cases) |

**The mechanism of the boot failures.** ECMAScript evaluates a strongly connected set of modules in one depth-first
pass; a module whose import is still being evaluated sees that binding in its temporal dead zone, and reading it
throws a `ReferenceError` (ECMA-262, *Cyclic Module Records* and *InnerModuleEvaluation*,
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

| Adopted element | Literature support | Comment |
| --- | --- | --- |
| One owner and one mechanism per capability | Parnas (one secret per module), Conway, Cataldo et al. | Correct; ownership is what makes inversion and consolidation someone's job |
| Manifest with public entries and allowed dependencies | Bazel visibility, Packwerk, Lakos physical design | Correct form; machine-readable, checkable without running code |
| Kinds (contract, core, application, adapter, composition root) and direction toward cores and contracts | Dijkstra layers, Lakos levels, Martin SDP/SAP, Cockburn, functional core | Correct; this is the levelled structure every source recommends |
| Pure cores and contracts: no I/O, clock, randomness; time and IDs as values | Functional core, Out of the Tar Pit, Effekt (capabilities from outside) | Correct and specific |
| Only composition roots choose implementations; one `createKernel`; one injected clock | Ports and adapters, Effect layers, Cordis loader | Correct |
| One declarative operation descriptor per operation, checked statically | Spatial composability (declared keys), Bazel | Correct; removes boot-time route conflicts once complete |
| Ratchet baseline that may only shrink | Packwerk's deprecated references, the earlier reports | Correct |
| Static check in seconds; `--changed` mode; module map in prompts | Uber/Google (graph-aware checks), agent studies (show relations) | Correct design; 10.5 s measured |

**What is missing.**

1. **Enforcement.** The check is wired to nothing. 1,014 new violations in 15.6 hours is the predictable result
   (Packwerk's experience is that dependency checks only "hold the line" when they gate). This is the largest gap and
   the cheapest to close.
2. **An acyclic declared graph.** Allowed dependencies were seeded from the current imports, so the manifest
   *declares* the cycle: 18 of 49 modules are on allowed-dependency cycles. The rule "the module graph is acyclic" is
   therefore unenforceable at module level; only rule 3 (new file-level value cycles) catches anything. The target
   graph must be declared as a DAG and the existing back edges moved into the baseline, where they can only shrink.
3. **Granularity.** Every Kernel domain is one `adapter` module. Purity rules apply to 13 small `core` modules; 95% of
   the code is in modules where anything is allowed. Lakos's unit of levelization is the *component*, a file pair, not a
   400-file directory. The kinds must apply inside domains: `access/contract`, `access/core`, `access/application`,
   `access/adapters`, and so on.
4. **No rule about evaluation at load.** The rules govern *what* may be imported, not *what may run when imported*.
   Cross-module top-level computation is what turns a cycle into a boot failure; it has no rule, no check, no count.
5. **No representation of registrations.** Modules mount themselves on a shared app (`modules?: ((app) => void)[]` in
   `http/kernel.ts:147`) and conflicts surface only when `createKernel` runs. Descriptors are adopted for operations
   but not for events, queues, permission catalogue entries or projections. The spatiotemporal paper's point is that
   all of these are effects on a shared context and should be declared values with inverses.
6. **No representation of ambient effects outside cores.** The clock rule applies to cores; adapters and applications
   call `Date.now()` in 257 files. Since 95% of the code is not a core, the rule binds little.
7. **No isolated verification.** Nothing lets a worker run a module without the system, and nothing proves that a
   module with zero static violations actually runs alone. Packwerk's retrospective shows that static cleanliness and
   runtime isolation diverge; Lakos and Parnas define isolation *by* testability of a subset.
8. **Interface changes are silent.** When a contract's export changes, dependents learn at integration. The agent
   evidence says this is the dominant failure of parallel writers and that a short explicit description of the change
   recovers most of it.

**What would fail at our rate of change.**

- *A baseline that is not gated* grows faster than any owner can shrink it: about 65 an hour against 90 removed in a
  day.
- *Coarse modules* hide new cycles inside them. With a 400-file `adapter`, rule 2 (public entries) cannot see
  intra-domain deep imports, and every new file is free to import any other file of its domain.
- *Snapshotted allowed dependencies* teach agents that whatever compiles is allowed: once a module pair is allowed,
  new file edges in either direction pass rule 2.
- *Rules that need judgment* (is this a core? is this constant shared?) are applied inconsistently by 30 agents. Rules
  must be decidable by the tool from the path and the import, as the manifest already intends.
- *A single boot test as the only runtime proof* serialises everything behind one expensive check and blames the
  wrong change. Module-local runtime proofs scale with the change.

## Recommended target paradigm

## Migration under a ratchet

## Prices

## Unverified claims

## Sources
