# Engineering modularity: why capabilities grow as entangled clusters

## Answer

Capabilities grow as entangled clusters because nothing in the delivery system owns, prices or checks structure.
Structure is a by-product of feature briefs. Goals are cut by product domain, and no active Goal owns the kernel's
shared machinery or the system's cross-cutting abstractions. Each brief is a feature journey measured by inserted
lines. Workers are told not to read architecture and are given no module map. Nothing at landing rejects a cycle,
an internal import or a second mechanism. So each worker builds the mechanism it needs next to its feature, inside its
own Goal's module and directly against PostgreSQL, Elysia and DBOS. The next Goal then imports that file's internals
or writes its own copy. The import graph becomes one strongly connected component. Checks become too expensive to run
before landing, so they move after it. The defects that follow get local workarounds, not structural repairs.

Measured on dev `86ed5367a0`: 19 of the kernel's 24 module nodes form one import cycle. 355 files across ten modules
form one value-import cycle. 409 files outside Access make 904 imports into its internals, against 39 through its
`index.ts`. Only 3% of kernel lines are free of effect libraries, directly and through their imports. Since the rewrite
began on 2026-10-25, 1,261 kernel source files have been added and 12 deleted. About 18 commits in six days repaired
load-order cycles.

H3 (no enforced boundaries) is the proximate cause. H1 and H2 are the upstream causes. H4 and H5 make the clusters
impossible to share and expensive to check. Two further causes came out of the evidence. One is a feedback loop:
coupling makes checks expensive, so the checks are removed. The other is an output metric that counts only inserted
lines. A one-time cleanup cannot hold: the whole kernel was written in eleven days, so new code outnumbers any
cleanup within a day. The fix has three parts that must ship together:

1. A **static architecture gate** on the merged candidate. It runs in seconds, needs no database and uses a ratchet
   baseline, so existing violations cannot grow.
2. **Owners for shared structure**: a platform Goal, a table of owners for cross-cutting capabilities, and a module map
   injected into every worker prompt.
3. **A price for consolidation**: deleted duplicate lines count as output, and the backlog has a standing
   consolidation share.

Then extract, in this order: problem and route contract, money, Access, command and idempotency, bounded-work cost,
subject identity epochs, and Web reader lifetime.

## Method and limits

- Source: detached dev `86ed5367a0107dc85d8cfc3a3675918ed5a42cf3` (2026-11-05 01:30 +08:00). This is desk research.
  No tests, compilers, linters, services or boundary tools were run. No product code changed.
- Read-only scripts, kept in `.temp/research/` and listed in the appendix:
  - `imports.py` builds the import graph. It counts modules, fan-in and fan-out, instability, surface, and
    strongly connected components (SCCs) at file and module level.
  - `purity.py` measures effect-free code.
  - `clones.py` estimates exact clones.
  - `brief_paths.py` measures which Goals declare paths in which modules.
  - `cycle_path.py` finds the shortest cycle path.
- Import parsing uses regular expressions over static `import`/`export … from`, side-effect imports and dynamic
  `import()`. An import counts as type-only when it is `import type`, or when every named specifier is `type`. Under
  `verbatimModuleSyntax` an all-`type` named import can still emit a module request, so the value-cycle counts are
  lower bounds.
- Goal attribution comes from the `goal` and `paths` front matter of 7,076 original briefs in the controller's brief
  store. These are declared paths, not observed edits. They show intent and assignment, not exact authorship.
- Not measured: how long the proposed checks take on this repository, whether SQL type declarations can be cached so
  the typecheck needs no database, and how much the identity-epoch participants duplicate. Each item below says how to
  settle it.

## 1. Root-cause model

### 1.1 What the code is

| Measure                                     | Value on `86ed5367a0`                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel source                               | 1,276 TS files, 379,840 lines; 1,979 SQL files, 24,416 lines; tests 685,362 lines                                                                                                                                                                                |
| Module-level cycle                          | 19 of 24 kernel module nodes in one SCC, with value imports only as well; all 26 Web modules in one SCC                                                                                                                                                          |
| Largest file-level value cycle              | 355 kernel files across access, commerce, community, content, http, library, rating, request, search and semantic; 396 files in 12 value SCCs, 5 of them cross-module. Web: 85 files, the largest 57 across features/media/subject                              |
| Imports of another module's internals       | Access: 904 statements from 409 files, against 39 through `access/index.ts`. Command 623, semantic 591, http 425, library 182, work 166. Tests add 1,535 deep imports into Access                                                                               |
| Module files imported from outside          | access 56%, semantic 58%, history 79%, work 77%, http 92%, command 100%. Only access and semantic have an `index.ts`; Access's is 1,135 lines of logic, not a facade                                                                                            |
| Effect-free code                            | 3% of kernel lines (12,011) import no pg, Elysia, DBOS, SQL file or I/O built-in, directly or transitively; 15% have no direct effect import. `packages/` holds about 20,000 lines of non-UI logic                                                              |
| Exact clones                                | 1.9% of 655,327 non-trivial lines sit in a 10-line window repeated in another file; 0.2% across modules                                                                                                                                                         |
| Repeated mechanisms (concept, not text)     | 34 `*Unavailable*Error` classes in 9 modules; about 26,000 lines in cost, budget, allowance, ledger and work-accounting files across 9 modules; Library's `NativeCollectionWork` used in 5 modules; `problemResponse` and money-unit rules in both kernel and Web; 26 exported function names defined in both kernel and Web |
| Growth since 2026-10-25 (kernel `.ts`)      | 1,261 files added, 12 deleted, 7,215 file modifications; deleted-to-added line ratio 0.08–0.26 a day; about 43,000 added and 34,000 net lines a day                                                                                                                            |
| Consolidation                               | About 145 of about 17,700 commit subjects mention consolidation or removal of duplicates (<1%), mostly documents and tests                                                                                                                                       |
| Cycle repairs                               | About 18 commits from 10-31 to 11-05 fix module-initialisation cycles: Realm denial classes, command work accounting, subject renderer registries, root validation, profile suites, rating initialisation, the header cycle, route inference                    |
| Workspace leaks                             | 20 Web files import `services/kernel/src` by relative path; 18 importer files import `packages/conversion/src` by relative path; 3 Web production files import story modules                                                                                   |

The exact-clone rate is low. The evidence fits re-derivation rather than copy and paste: workers write a fresh
mechanism shaped like an existing one, under different names. Clone detectors and GitClear-style copy/paste metrics will
therefore under-report this codebase's duplication. The useful metric is implementations per concept (section 5).

### 1.2 Who writes where

Share of briefs that declare paths in a module, by Goal (`brief_paths.py`):

| Module            | Briefs | Goals | Largest Goal's share   | Reading                                           |
| ----------------- | -----: | ----: | ---------------------- | ------------------------------------------------- |
| kernel/imports    |    182 |     3 | 0.98 imports           | Domain module = one Goal                          |
| kernel/library    |    586 |     6 | 0.92 commerce          | Domain module = one Goal                          |
| kernel/content    |    599 |     7 | 0.92 content           | Domain module = one Goal                          |
| kernel/search     |    508 |     7 | 0.86 search            | Domain module = one Goal                          |
| kernel/access     |    458 |     8 | 0.80 accounts          | Domain module = one Goal                          |
| kernel/command    |     43 |     6 | 0.53 accounts          | No owner; many writers                            |
| kernel/history    |     55 |     5 | 0.49 accounts          | No owner; many writers                            |
| kernel/http       |    284 |     8 | 0.41 commerce          | No owner; most-written shared module              |
| kernel/work       |     78 |     6 | 0.33 accounts          | No owner                                          |
| kernel/events     |     56 |     7 | 0.25 semantic          | No owner                                          |
| packages/client   |    642 |     9 | 0.28 content, commerce | Generated contract; everyone writes               |

No Goal definition owns `http`, `command`, `events`, `history`, `request`, `route`, `tokens`, `partition` or
`database`. The accounts definition says "Kernel owns partition and request machinery", but the
[Goal index](../goals/README.md) records the kernel foundation as completed with no active Goal. The
[scope table](../scope.md) lists only user-facing systems. These unowned modules have the most writers, the highest
fan-in and the worst layering. Every one of today's four failures happened there.

### 1.3 Hypotheses

| Hypothesis                                                                          | Verdict and confidence                    | Decisive evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 Conway: cross-cutting abstractions split by Goal ownership                      | Holds, refined; 0.75                      | Domain modules mirror Goals (0.80–0.98 owner share). Cross-cutting mechanisms are not split; they are born inside the first consumer's module and imported from there. `NativeCollectionWork`, a Library type, is used by semantic (15 files), search, access and command. Money lives in commerce and was copied into Web. The Access contract lives in the accounts module. Shared infrastructure has no owner (§1.2). Conway's thesis predicts exactly this mirroring.                                                                                                                                                                                                             |
| H2 Locality: workers add next to their feature; nothing pays for consolidation    | Holds; 0.8                                | 1,261 files added against 12 deleted. Under 1% of commits consolidate. Re-derived mechanisms appear in nine modules. Briefs are 2,000–3,000-line feature journeys, and the hourly target counts inserted lines (`efficiency-report.ts` parses `insertion`). Workers are told their brief is self-sufficient and must not open architecture or scope unless linked ([agent conduct](../development/agent-conduct.md)). The worker prompt has no reuse or placement rule.                                                                                                                                          |
| H3 No enforced boundaries                                                          | Holds strongly; proximate cause; 0.9      | No document states a dependency rule. `.oxlintrc.json` turns every category off and keeps six rules, with no import plugin and no `no-cycle`. `scripts/workspace-imports.ts` checks only that imported packages are declared. `tools/goal/risk-areas.json` globs such as `**/auth/**` and `**/account/**` do not match `services/kernel/src/access`. The local integration settings have dev landing checks, the prelanding typecheck and affected tests off; the [integration section](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing) says no affected, sibling, import or story validation runs before the dev ref advances.                       |
| H4 Missing abstraction step                                                         | Holds for system vocabularies; 0.65       | Product vocabulary has an owner (`packages/definitions`). System vocabularies have none: permission and action keys, actor and decision, money units, cost bounds, problem codes, route metadata. The Access README is 4,996 lines in 142 sections ordered by delivery. Its first line is a cycle workaround: "resource-role identifier helpers are functions so circular Access composition can resolve during module load." The old `@rezics/access` README opened with its vocabulary and stated that no consumer may define a second permission registry. [Feature design](../development/feature-design.md) maps a job to the graph but has no module-design step. |
| H5 Framework entanglement                                                          | Holds; 0.75                               | 3% of kernel lines are transitively effect-free. `request/access.ts`, the contract every module imports, imports pg, `history/record.ts`, `command/command.ts` and eight Access internals. `commerce/money.ts` has no imports at all, yet `apps/web/src/checkout/money-schema.ts` re-implements its unit and sale-rule checks because a kernel file cannot be consumed by Web. Kernel typecheck needs a check host and a migrated database ([compiler placement](../development/compiler-check-placement.md)), because pure and SQL-typed code share one TypeScript project.                                    |
| H6 (new) Check-cost feedback loop                                                   | Holds; 0.7                                | Coupling made the kernel's affected-test selection pick 649 and 834 of about 860 test files for wide changes, so affected tests were switched off at landing. A typecheck needs a database, so the prelanding typecheck is off. The boot test that now guards landing took 320 s (`d7f0d9efb0`). Each removed check lets more coupling land.                                                                                                                                                                                                                                                                       |
| H7 (new) Output metric rewards insertion                                           | Contributes; 0.6                          | The hourly report counts inserted product lines against a 20,000 an hour target. A consolidation that deletes 3,000 lines and adds 1,000 scores 1,000. The ratio of 12 deletions to 1,261 additions fits that incentive, but this is correlation; no counterfactual was measured.                                                                                                                                                                                                                                                                                                                                  |

### 1.4 Today's four failures, traced

1. **Start-up cycle (`IDEMPOTENCY_HEADER` used before initialisation).** The shortest value-import path from
   `http/request.ts` back to itself is:
   `http/request.ts → http/problem.ts → request/access.ts → access/permission.ts → access/kind-audience-original.ts →
   library/collection-kind-input.ts → library/collection-source-native.ts → access/gates/admission.ts →
   http/request.ts`. The HTTP error mapper is infrastructure, yet it value-imports `AuthenticationError` from the
   Access contract. That contract reaches Library internals, which import an Access gate, which imports HTTP. The
   repair `2a5d8ce63b` moved three header constants into a leaf file. The 355-file cycle remains. Rules R2, R3 and R4
   below would have refused the first edge.
2. **Conflicting route security declarations.** Each module writes `operationId`, `x-action`, `security` and
   `x-rate-limit` into Elysia route details. The grammar is checked only when routes mount
   (`http/request.ts:111–113`). Security is merged per `operationId`, and a disagreement silently becomes `unknown`
   (`http/kernel.ts:106–129`). `http/write-rate-routes.ts` holds a hand-written list of other modules' write actions.
   Conflicts appear only when `createKernel` runs, and they block unrelated tasks. `07347657df` records that
   "createKernel is blocked by an unrelated collections operationId". Rule R7 makes this a static check that runs in
   seconds.
3. **Deleted helper still called.** `3f7ba86995` removed `projectNativeSQL` while a top-level constant in the same
   file still called it. Kernel API, worker, Auth host and seed entries failed with a `ReferenceError`, and
   `d7f0d9efb0` restored the helper. Any typecheck would have failed. The worker prompt asks for one
   (`tools/goal/src/launch.ts:187`), but that is advice, not enforcement. The kernel typecheck needs a remote
   database, and the train's typecheck is off. W1 and W9 close this gap.
4. **Runtime cost accounting copied across Collection, History and Work.** The [duplication audit](architecture-duplication-audit.md)
   ranks it first. It persists because `architecture.md` forbids runtime price protocols, but no tool checks the rule
   and no one owns cost machinery across modules. About 26,000 lines of cost-named code sit in nine modules. Rule R6
   and roadmap item 5 address it.

### 1.5 Causal chain

1. Goals are cut by product domain. The kernel foundation Goal closed. No Goal owns infrastructure or the system
   vocabularies that cross domains. *(H1)*
2. Briefs are feature journeys, sized and rewarded by inserted lines. Workers read only their brief, so they cannot
   know that a shared mechanism exists or where one should go. *(H2, H7)*
3. A worker who needs a mechanism builds it in its own module, inside the feature's files, written directly against
   pg, Elysia and DBOS. No vocabulary or port is written first. *(H4, H5)*
4. The next Goal needs the same mechanism. It deep-imports the file, because there is no public entry and no rule, or
   rebuilds it, when the consumer is Web or another workspace. *(H3, H5)*
5. The import graph collapses into one SCC. Module load order becomes fragile. Global declarations collide, but only
   when the kernel boots.
6. Checks become expensive: affected tests select nearly every test, the typecheck needs a database, and the boot
   test takes minutes. To keep throughput, the checks move after landing. *(H6)*
7. Defects land and get local workarounds that make the structure worse: leaf constants, lazy getters, and setter
   injection on a shared object (ten `install*` functions, eight of them in Access, such as
   `installCredentialFloorBridge`). Consolidation earns nothing, so no one restructures. Go back to step 3.

**Root cause:** structure has no owner, no price and no gate. Remove all three together. A gate without owners
produces workarounds that pass the gate; owners without a gate cannot keep up with 32 parallel workers; and with no
price, no one spends capacity on consolidation.

## 2. Architecture rules

### Module kinds

| Kind                 | Where                                                                                                 | May depend on                                                                                                                             | May not                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Vocabulary           | `packages/<capability>`, `kind: vocabulary`                                                           | Other vocabulary packages; allowlisted pure libraries (`typebox`, `canonicalize`, `@noble/hashes`)                                        | Any service, app, core or adapter; Node built-ins; module-level mutable state                                                         |
| Core                 | `packages/<capability>`, `kind: core`, or `services/*/src/<module>/core/`                             | Vocabulary; other cores (acyclic); the same allowlist                                                                                     | pg, Elysia, DBOS, Stripe, `.sql` imports, `node:fs`/`net`/`async_hooks`/`child_process`, `install*` setters, module-level `let`     |
| Service module       | `services/<service>/src/<module>/` with `index.ts` as its only public entry                           | Its own core and adapters; vocabulary; other modules' `index.ts`; infrastructure modules' `index.ts`                                     | Another module's non-entry files; app or story code                                                                                    |
| Infrastructure       | `services/kernel/src/{http,command,work,events,history,request,route,tokens,partition,database}`      | Vocabulary, cores, other infrastructure entries in one fixed order                                                                        | Any domain module (access, library, content, community, rating, search, semantic, commerce, zones, presentation, imports)             |
| Adapter              | Inside a service module: `*-routes.ts` (Elysia), `*-store.ts` and `.sql` (pg/Reylo), `*-work.ts` (DBOS) | Its module's core and vocabulary; infrastructure entries                                                                                  | Being imported by a core or vocabulary                                                                                                  |
| Composition root     | `server.ts`, `worker.ts`, `http/kernel.ts`, `work/modules.ts`, `events/catalogue.ts`                  | Any module's `index.ts`                                                                                                                   | Being imported by anything except entry points and tests                                                                               |
| App                  | `apps/*`                                                                                              | Packages through their `exports`; the generated client                                                                                    | Any `services/**` path; another workspace by relative path                                                                             |

### Rules

Each rule is enforced by the architecture check in W1 and runs against a baseline: existing violations are listed in
a committed file, which may only shrink, and new violations fail the landing. The recommended engine is
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser), which "validates them against (your own) rules"
and supports `--ignore-known` baselines so that known violations do not hide new ones
([CLI docs](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md)). Where a rule needs text matching
rather than the import graph (R6, R8), a short script beside `scripts/workspace-imports.ts` covers it.

**R1. Packages live in `packages/<capability>`; services own adapters.**
A capability's vocabulary and pure core become a package with `exports` limited to `./src/index.ts` and
`sideEffects: false`. Its README starts with a Vocabulary section. A package may not depend on any `services/*`
workspace.
*Rationale:* published language ([Evans](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf):
"Use a well-documented shared language that can express the necessary domain information as a common medium").
*Check:* a manifest check (`exports` shape, dependency allowlist per kind) plus dependency-cruiser's
`not-to-unresolvable` and `no-non-package-json` rules.
*Prevents:* Web's copy of money rules, and the importer's relative imports into `packages/conversion/src`.

**R2. System vocabulary is written first and lives in a leaf.**
Types, constants, error and problem classes, header names, action and permission keys and cost-bound shapes go in
vocabulary modules that import nothing outside the vocabulary layer. A new cross-cutting capability lands its
vocabulary file and its ports before, or in the same task as, the first adapter.
*Rationale:* Parnas's criterion: "begins with a list of difficult design decisions or design decisions which are
likely to change. Each module is then designed to hide such a decision from the others"
([Parnas 1971/1972](https://prl.khoury.northeastern.edu/img/p-tr-1971.pdf), p. 24). Placing error and constant
vocabulary at leaves keeps their consumers from loading implementation.
*Check:* the vocabulary kind's forbidden-import rule; a text check that `class \w+Error extends` appears only in
vocabulary modules or a module's `errors.ts`.
*Prevents:* the `http/problem.ts → request/access.ts` edge at the centre of the start-up cycle, and the 34 separate
`Unavailable` error classes.

**R3. No value-import cycles.**
No cycle may run through value imports, inside or across modules. Type-only cycles are allowed.
*Rationale:* Martin's Acyclic Dependencies Principle: "the dependency graph of packages or components should have no
cycles" ([ADP](https://en.wikipedia.org/wiki/Acyclic_dependencies_principle)). In ESM, a value cycle makes
initialisation order part of the contract, which is the `IDEMPOTENCY_HEADER` failure.
*Check:* dependency-cruiser `no-circular`, restricted to non-type dependencies (verify the exact option on install).
For editor feedback, oxlint's `import/no-cycle` with `ignoreTypes: true`
([oxlint rule](https://oxc.rs/docs/guide/usage/linter/rules/import/no-cycle.html)).
*Prevents:* the roughly 18 cycle-repair commits of 10-31 to 11-05 and the start-up crash.

**R4. Dependencies point toward stability.**
The layers are: vocabulary, then core, then infrastructure, then domain modules, then composition roots. Each may
import only layers before it. Infrastructure may not import domain modules; domain modules reach infrastructure only
through its `index.ts`. Infrastructure modules follow one recorded order. A starting proposal is route, partition,
tokens, database, request, command, events, history, work, http. The platform owner fixes the final order from the
current graph, choosing the one with the fewest reversed edges; today history, command and work import each other
both ways.
*Rationale:* the Stable Dependencies Principle and instability `I = Ce/(Ce+Ca)`
([package metrics](https://en.wikipedia.org/wiki/Software_package_metrics)). `request` (I = 0.21) and `database`
(0.16) are stable and must not depend on volatile domain code. Today `http/problem.ts`, `http/app.ts`,
`command/command.ts`, `command/operational.ts` and `work/authorization.ts` import domain modules.
*Check:* dependency-cruiser `forbidden` rules with path groups.
*Prevents:* the start-up cycle, and the command↔history↔work cycles (12 files, plus 8 more with access).

**R5. Cross-module imports go through the public entry.**
Outside a module, import only `<module>/index.ts` or a package's `exports`. No relative import may leave its
workspace. Tests may import their own module's internals and other modules' entries.
*Rationale:* information hiding and deep modules (Ousterhout, as summarised in
[these book notes](https://danlebrero.com/2021/02/24/philosophy-of-software-design-summary/): "interface much simpler
than implementation"). Bazel makes targets private by default for the same reason, to separate "your library's public
API and its implementation details" ([Bazel visibility](https://bazel.build/concepts/visibility)).
*Check:* a dependency-cruiser rule for kernel module paths that are not `index.ts`; workspace escapes detected by
path.
*Prevents:* 904 deep imports into Access, 20 Web files importing kernel source, and the deleted-helper class, since a
public entry change is visible and owned.

**R6. One registered mechanism per concept.**
`docs/architecture.md` gains a registry table naming each cross-cutting mechanism, its owner module and its entry:
problem codes, route declarations, actions and permissions, event types, work modules, erasure participants,
identity-epoch participants, cost bounds, cursors, clocks and deadlines, money units, session observation. A second
definition fails the check.
*Rationale:* the existing "one capability has one authority" principle becomes executable. Ousterhout's information
leakage is the same design decision reflected in several modules.
*Check:* text rules per concept, each listing the allowed paths for its pattern, for example
`/class \w*UnavailableError/` or `/(Ledger|Allowance|Budget)\b/` type names; exported symbols defined in two
workspaces under the same name (26 today).
*Prevents:* the cost-accounting copies and the kernel and Web copies of `problemResponse` and money rules.

**R7. Global declarations are static data and are checked statically.**
Route metadata (`operationId`, action, security, rate limit, idempotency) is exported from each module as typed data.
A pure function validates the union: grammar, uniqueness, and agreement of security per `operationId`. It runs at
landing with no database and no `createKernel`. The same applies to event types and problem codes.
*Rationale:* DDD's shared kernel is "explicitly shared stuff" that "shouldn't be changed without consultation"
([Evans](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf)). Checking it statically
moves the consultation to the moment of change.
*Check:* `bun test` of a declaration test file, local and in seconds.
*Prevents:* operationId and security conflicts found only at mount, and the silent `unknown` collapse.

**R8. Cores and vocabularies are pure.**
No effect library, I/O built-in, `.sql` import, module-level mutable state or setter injection. Ports are interfaces
that the core declares and adapters implement.
*Rationale:* hexagonal architecture, so the application can be "developed and tested in isolation from its eventual
run-time devices and databases" ([Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)). Pure code also
typechecks without a database (see W9).
*Check:* the forbidden-import rule for the vocabulary and core kinds; a text check for `^let ` and
`export function install` in core paths.
*Prevents:* `commerce/money.ts` being unshareable, and the Access contract importing pg.

**R9. Adapters are named by technology and stay inside their module.**
Elysia code lives in `*-routes.ts`, pg and Reylo code in `*-store.ts` with colocated `.sql`, DBOS steps and
registration in `*-work.ts`. A file importing elysia, pg or `@dbos-inc/*` must carry one of these suffixes, or sit in
the corresponding infrastructure module or composition root. Existing files are baselined; the suffixes already
dominate.
*Rationale:* makes the imperative shell visible to agents and reviewers, and makes R8 cheap to check.
*Check:* a script mapping each effect import to its allowed suffix.
*Prevents:* rules mixed into transaction code, which keeps 85% of kernel lines impure.

**R10. What may become a package.**
A capability becomes a package when its vocabulary or rules are needed by two workspaces (kernel and Web, or kernel
and importer), or when its pure core is imported by three or more kernel modules. It must satisfy R1, R2 and R8.
Adapters, React lifecycle and SQL never enter packages. Publishable shape: a single entry, a README with Vocabulary,
Rules and Ports sections, and tests that need no service.
*Rationale:* Martin's Common Closure and Common Reuse principles group what changes together; Fowler: "DDD deals with
large models by dividing them into different Bounded Contexts and being explicit about their interrelationships"
([Bounded Context](https://martinfowler.com/bliki/BoundedContext.html)).
*Check:* the same-name report from R6 lists candidates; the manifest check validates shape.
*Prevents:* new kernel and Web pairs like `recordedMoneyUnit`, `validReviewContextBinding` and
`classificationAssociationKey`.

## 3. Work-system changes

The landing train handles 32+ parallel workers. Every change below either costs seconds or replaces a costlier step.

| Change                                                | What exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Throughput cost                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 Static architecture gate before the dev ref moves** | Run `bun scripts/architecture.ts` on the final candidate of each single or batch landing. It runs dependency-cruiser with the committed baseline, `scripts/workspace-imports.ts` (already static, now after integration only), the R6/R8/R9 text checks and the R7 declaration test. A failure returns to the same worker session with a message that names the rule, the edge and the fix, for example "import `access/index.ts`" or "move this class to `problem`". The baseline file is changed only by consolidation tasks and must shrink. | Unmeasured. Expected seconds to about a minute with dependency-cruiser's `--cache`, against 320 s for the boot test. No database, no host. Settle with one timed run on a check host before making it blocking. |
| **W2 Same check inside the worker loop**              | The worker prompt replaces the advisory typecheck line with "run `bun scripts/architecture.ts --changed` and the typecheck of pure packages you touched". The controller runs the check at settle and resumes the session on failure, the same deterministic pattern Claude Code documents for Stop hooks ([best practices](https://code.claude.com/docs/en/best-practices): "If something has to happen every time, make it a hook"). | One local command per attempt; it prevents gate refusals and retries.                                                                  |
| **W3 Platform Goal (inverse Conway)**                 | A resident platform manager owns the infrastructure modules, the problem, route and bounds packages, `docs/architecture.md`'s registry table, the dependency-cruiser config and the baseline. [Fowler](https://martinfowler.com/bliki/ConwaysLaw.html): "Change the communication patterns of the designers to encourage the desired software architecture." Add a "Shared capabilities" table to [scope](../scope.md): access → accounts; money → commerce; cost bounds → performance (derivation) and platform (execution); identity epochs → semantic; discovery → search; erasure orchestration → accounts; problem, route, command, work, events → platform; reader lifetime → web. | One more manager. It needs no extra worker width; its briefs replace infra edits other Goals make today (479 commits since 10-25).        |
| **W4 Module map in every worker prompt**              | Generate `docs/architecture/modules.json` (path → kind, owner Goal, public entry, registries) and a ≤2,000-character map from it. Inject the map into every worker prompt as the only architecture text a worker receives. Fix `tools/goal/risk-areas.json` to match the real layout. OpenAI's Codex team reportedly keeps a short AGENTS.md as a map and enforces a fixed layer order "through mechanical rules and structural tests" ([InfoQ on harness engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex); the primary post was unreachable). | Adds about 2,000 characters to a 20,000-character prompt budget; removes rediscovery reads.                                            |
| **W5 Brief front matter: `module` and `consumes`**    | A product brief names the module it changes and the public entries it consumes. Dispatch refuses a brief whose paths cover the internals of more than one domain module, unless it is a consolidation brief by the owner (709 briefs declared more than one kernel module). A brief that adds a mechanism names the registry entry it extends, or states that the map has none, and then lands the vocabulary and ports first (R2). | Parser-only; no model cost. Some briefs split; most already target one module (owner share ≥0.8).                                       |
| **W6 Cross-module change protocol**                   | Changing another module's `index.ts` or a vocabulary package is allowed, but the controller notifies the owner, and the owner's sampled review covers it. Producers decide their interfaces, as [delivery](../development/delivery.md) already says. Only R1–R10 block landing; human or agent review never does.                                                                                                                                                       | Asynchronous; no wait added to landings.                                                                                                |
| **W7 Consolidation budget and credit**                | Each Goal keeps at least one of its eight ready briefs as a consolidation or extraction brief from §4 or from the platform owner's list. In the hourly report, deleted product lines in consolidation tasks count as output, and architecture metrics (§5) sit beside the line count. The 20,000-line target is not applied to consolidation tasks.                                                                                                                         | About 12% of width, recovered through fewer cycle and boot repairs and narrower test selections.                                          |
| **W8 Review one question**                            | Managers' sampled reviews (about two landings an hour) add one question: "did this add a second mechanism for something in the map?" Platform reviews the weekly metrics and briefs the largest regression. A new shared vocabulary is an expensive-to-reverse decision, so it gets the existing two-researcher rule.                                                                                                                                                    | Fits within existing review time.                                                                                                       |
| **W9 Cheap typecheck**                                | Pure code moved into packages typechecks locally, in seconds, with no database. Make that typecheck blocking at landing for changed packages. Separately, measure whether Reylo's SQL declarations can be generated once per migration set and committed or cached, so a TypeScript-only kernel change typechecks without a database. *Unsure:* depends on how Reylo's content mapper resolves types. Settle by reading its source and timing one TS-only kernel typecheck. | Package typechecks: seconds. Kernel typecheck: unknown until measured.                                                                  |

Evidence that this matters for agent-built code:

- Cursor adoption brought "a statistically significant, large, but transient increase in project-level development
  velocity" and "a substantial and persistent increase in static analysis warnings and code complexity", which the
  authors identify as "major factors driving long-term velocity slowdown" ([He et al.](https://arxiv.org/abs/2511.04427)).
- GitClear's 211 million changed lines show moved (refactored) code falling "from 25% of changed lines in 2021, to
  less than 10% in 2024" ([GitClear 2025](https://www.gitclear.com/ai_assistant_code_quality_2025_research)).
- DORA found AI adoption "accompanied by an estimated decrease in delivery throughput by 1.5%, and an estimated
  reduction in delivery stability by 7.2%", and named "small batch sizes and robust testing mechanisms" as the basics
  ([DORA 2024](https://cloud.google.com/blog/products/devops-sre/announcing-the-2024-dora-report)).
- Vendor guidance is that prose rules shape behaviour but do not guarantee it. Anthropic separates non-deterministic
  instructions (`CLAUDE.md`, skills) from deterministic ones (hooks, CI) ([best practices](https://code.claude.com/docs/en/best-practices);
  [hooks](https://code.claude.com/docs/en/hooks-guide)). Cursor recommends focused rules under 500 lines
  ([Cursor rules](https://cursor.com/docs/context/rules)). Codex concatenates `AGENTS.md` files up to 32 KiB
  ([Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)).
- For monorepos, Nx's tags and `depConstraints` work the same way: "Projects without any tags cannot depend on any
  other projects" ([Nx](https://nx.dev/docs/features/enforce-module-boundaries)). TypeScript project references
  "enforce logical separation between components" ([handbook](https://www.typescriptlang.org/docs/handbook/project-references.html)).
  REZICS needs the rule engine, not a new build system, so dependency-cruiser plus manifest checks are enough.

## 4. Extraction roadmap

**Step 0 (one control-plane task and one dev task).** Install the W1 check with a baseline generated from current
dev. Write the R6 registry table and the module map. Add the platform Goal and the Shared capabilities table. Without
this step every extraction below decays within days.

Each item below is one or two 2,000–3,000-line journeys with a native outcome. Each lowers the baseline by a number
the gate can see.

| #   | Capability (owner)                                    | Scope                                                                                                                                                                                                                                                              | Interface sketch                                                                                                                                                                                                                                                                                                                             | Payoff                                                                                                                                                                                                                                                                    | First journey                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Problem and route contract (platform)                | `packages/problem`: problem codes, status/title/retryable table (`http/problem-error.ts`), `ProblemError`, one `UnavailableError` family with reasons, `AuthenticationError`. Kernel leaf `http/contract.ts`: header names, idempotency key grammar, route declaration type, pure catalogue check. | `type ProblemCode`; `PROBLEMS: Record<ProblemCode,{status,title,retryable}>`; `problemDocument(error: unknown): ProblemDocument`; `type RouteDeclaration = {method, path, operationId: \`${string}.${string}\`, action?, security: 'anonymous'\|'authenticated', rateLimit?}`; `checkRouteCatalogue(decls): RouteIssue[]` | Removes the infrastructure-to-Access edge at the hub of the 355-file cycle. Folds 34 Unavailable error classes into one family with reasons. Web's `problemResponse` reads the same codes. Route conflicts are refused in seconds instead of at boot.                                         | "A reader gets the same problem document for the same refusal from the Kernel API and the Web server": move the classes, point both `problemResponse` implementations at the package, and add the R7 declaration test naming duplicate or conflicting operationIds. Acceptance: boot test passes and the largest value SCC shrinks.            |
| 2   | Money (commerce)                                     | `packages/money` from `services/kernel/src/commerce/money.ts`, which has no imports: money units, Stripe unit facts, sale currency rules and amount validation.                                                                                                     | `type MoneyUnit`; `readStripeMoneyUnit(currency, context)`; `recordedMoneyUnit(value)`; `type SaleCurrencyRule`; `validateSaleAmount(rule, amountMinor)`                                                                                                                                                                                     | Small in lines (about 100 deleted from Web). Large as proof that a vocabulary package can serve kernel and Web, which settles R10 in practice.                                                                                                                             | "A seller's out-of-range price is refused with the same message in the checkout form and by the API": Web drops `checkout/money-schema.ts` rules and imports the package.                                                                                                                                                                  |
| 3   | Access (accounts; detailed by the Access research)   | `packages/access` vocabulary: action and permission keys (78 `x-action` literals now spread through route files), `Actor`, `Resource`, `Decision`, viewer-action shapes, scopes; a pure decision core for rules that need no reads. Kernel `access/index.ts` becomes the only entry; stores and gates stay adapters. | `type ActionKey`; `type Actor`; `type Decision = {allowed, reason}`; `decide(rule, facts): Decision`; ports `GrantReader`, `AccountStateReader`; kernel `createAccess(ports): Access`                                                                                                                                                     | The highest fan-in module (Ca = 18): 904 deep imports from 409 files collapse to one entry. Web uses the same action vocabulary. Rebuilds the old package's "no second permission registry" guarantee.                                                                    | "Viewer actions for one resource kind are read through the Access entry only": migrate the top three internals (`authenticate.ts` 156 imports, `unavailable.ts` 120, `grant-commands.ts` 114) behind `index.ts` and baseline the rest.                                                                                                      |
| 4   | Command and idempotency (platform)                   | `services/kernel/src/command` with `index.ts`: principals, idempotency keys, receipts, authoritative time, fences, operational admission. Vocabulary into a leaf; History and Work register through ports instead of being imported.                                 | `runCommand(spec, input, context): Promise<CommandResult>`; `type CommandPrincipal`; `type IdempotencyKey`; `type CommandReceipt`; `interface CommandHistorySink`                                                                                                                                                                           | 623 deep imports; 100% of files imported from outside; breaks the command↔history↔work SCCs.                                                                                                                                                                             | "A retried command returns its original receipt" through the entry only; History becomes a sink that the composition root registers.                                                                                                                                                                                                       |
| 5   | Bounded-work cost (performance derives; platform executes) | `packages/bounds`: cost axes and static bound declarations with composition by sum. Work execution keeps identity, deadlines, attempts and replay. Runtime ledgers are deleted as callers move.                                                                    | `type Bound = Readonly<{statements, rows, bytes, …}>`; `declareBound(producer, bound)`; `sumBounds(...bounds)`; `withinCeiling(bound, ceiling)`                                                                                                                                                                                             | About 26,000 lines of cost-named code in nine modules. `NativeCollectionWork` leaves Library. Brings code into line with the static-ceiling rule in [architecture](../architecture.md). Continues the [audit's](architecture-duplication-audit.md) first finding.          | "Search scope member pages and the semantic catalogue ledger declare static bounds": replace `withMembersWorkBudget` and `CatalogueLedger` runtime accounting; growth checks still pass.                                                                                                                                                  |
| 6   | Subject identity epochs (semantic)                   | A pure resolver for canonical, redirected and erased subject identity, plus the participant port that `semantic/identity-epoch-contract.ts` already sketches. Participants in library, search, rating, commerce and content become adapters of that port.            | `resolveIdentity(epoch, key): Canonical \| Redirect \| Erased`; `interface IdentityEpochParticipant { observe(epoch, keys): Promise<ParticipantResult> }`                                                                                                                                                                                  | About 37,000 lines in identity-named files across seven modules; epoch references in library (24 files), search (13), rating (5). *Unsure* how much participants re-implement resolution. Settle by diffing the four largest participants before briefing.                | "A merged subject resolves the same way on a Library shelf and in search results": both participants call the pure resolver.                                                                                                                                                                                                               |
| 7   | Web reader lifetime (web)                            | One retiring session observation per client, with typed read, operation and address leases. Moves out of `library/` into `apps/web/src/session`, which is the module's only public entry.                                                                           | `observeSession(client): SessionObservation`; `readLease(descriptor)`; `operationLease(descriptor)`                                                                                                                                                                                                                                           | 40 lifetime and admission files across seven Web modules; the [audit's](architecture-duplication-audit.md) findings 2 and 6. Privacy-sensitive retirement rules converge.                                                                                               | "My ratings and the catalogue editor retire stale reads after a sign-out": Ratings stops importing Library; both use the session module.                                                                                                                                                                                                   |

**Order and why.**

- Step 0 first, because without the gate and owners every extraction decays.
- Item 1 next: it is the hub of the main cycle, and it unlocks the R7 static check.
- Item 2 is cheap and proves the package pattern on both sides of the stack.
- Item 3 has the largest fan-in.
- Item 4 is the second cycle hub.
- Item 5 has the largest duplicated volume, and it needs the ports from items 3 and 4.
- Items 6 and 7 are independent and can run in parallel under their owners.
- The audit's retained-list metadata coordinator (its finding 4) stays a Commerce brief. It consolidates inside one
  Goal and does not need to wait for this roadmap.

## 5. What would prove this wrong

Run the scripts in the appendix weekly, along with the gate's own counts once it exists, and publish the numbers in
the hourly report's daily summary.

| Metric                                                     | Baseline (`86ed5367a0`)                                  | Expected after 2 weeks                         | Reading if it does not move                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline violations (gate)                                 | Generate at install; proxies below                       | Falls every week                               | Consolidation work is cosmetic or not dispatched                                                                |
| New violations refused at landing                          | n/a                                                      | Some refusals, falling                         | Zero refusals while the baseline is flat: the gate is bypassed or too loose                                     |
| Largest value-import SCC                                   | 355 files, 10 modules                                    | Under 100 files, at most 3 modules             | Cycles regrow through new edges; H3 alone is insufficient                                                       |
| Modules in the kernel module-level SCC                     | 19 of 24                                                 | Composition roots only                         | Layer rule R4 mis-specified                                                                                     |
| Deep imports into other modules                            | Access 904, command 623, semantic 591, http 425          | −30% overall                                   | Public entries are not deep enough to use                                                                       |
| Effect-free share of kernel plus packages                  | 3% transitive                                            | Rising; packages hold the cores of items 1–3   | H5 is not being addressed                                                                                       |
| Implementations per concept                                | 34 Unavailable classes; 26 kernel/Web shared names; cost ledgers in 9 modules | Falling; zero new ones                         | New duplicates while violations fall: information and incentive (H2, H4) dominate, so invest in W4, W5 and W7 |
| Deleted to added product lines                             | 0.25                                                     | At least 0.35 while the budget runs            | W7 not funded                                                                                                   |
| Cycle, boot and missing-symbol repair commits              | About 4 a day                                            | At most 1 a week                               | The gate does not cover the failure class                                                                       |
| Infrastructure written by its owner                        | Largest-Goal share 0.25–0.53                             | Platform at least 0.7                          | H1 wrong, or platform under-resourced                                                                           |
| Throughput guardrails                                      | Landing p90 target 30 min; ≤1.5 attempts per task; hourly product lines | No drop over 10% attributable to the gate | The checks are too slow or the messages unclear; fix W1 before adding rules                                      |

Falsifiers for the model itself:

- If the gate and ownership reduce new violations but new conceptual duplicates keep landing, H3 is not the dominant
  cause. Brief shape and the information diet are (H2, H4).
- If infrastructure defects fall with the gate alone, before the platform Goal exists, H1 matters less than claimed.
- If consolidation briefs land and the baseline does not fall, the budget is buying churn.

## Sources

Only sources retrieved during this research are listed.

- D. L. Parnas, *On the criteria to be used in decomposing systems into modules*, CMU technical report 1971 (published
  in CACM 1972): https://prl.khoury.northeastern.edu/img/p-tr-1971.pdf
- M. Conway, *How Do Committees Invent?*, Datamation 1968: https://www.melconway.com/Home/Committees_Paper.html
- M. Fowler, *Conway's Law* (inverse Conway manoeuvre): https://martinfowler.com/bliki/ConwaysLaw.html
- M. Fowler, *Bounded Context*: https://martinfowler.com/bliki/BoundedContext.html
- E. Evans, *Domain-Driven Design Reference* (2015): Shared Kernel, Anticorruption Layer, Published Language:
  https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf
- A. Cockburn, *Hexagonal Architecture*: https://alistair.cockburn.us/hexagonal-architecture/
- Package metrics (Martin's Ca, Ce, I, A, D): https://en.wikipedia.org/wiki/Software_package_metrics; Acyclic
  Dependencies Principle: https://en.wikipedia.org/wiki/Acyclic_dependencies_principle
- J. Ousterhout, *A Philosophy of Software Design*, through secondary book notes, because the author's page could not
  be fetched: https://danlebrero.com/2021/02/24/philosophy-of-software-design-summary/
- Nx module boundaries: https://nx.dev/docs/features/enforce-module-boundaries
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser and its CLI baseline documentation
  https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md
- eslint-plugin-boundaries: https://github.com/javierbrea/eslint-plugin-boundaries
- Bazel visibility: https://bazel.build/concepts/visibility
- TypeScript project references: https://www.typescriptlang.org/docs/handbook/project-references.html
- oxlint `import/no-cycle`: https://oxc.rs/docs/guide/usage/linter/rules/import/no-cycle.html
- H. He et al., *Speed at the Cost of Quality* (arXiv 2511.04427 v3): https://arxiv.org/abs/2511.04427
- GitClear, *AI Copilot Code Quality 2025*: https://www.gitclear.com/ai_assistant_code_quality_2025_research
- Google Cloud, *Announcing the 2024 DORA report*: https://cloud.google.com/blog/products/devops-sre/announcing-the-2024-dora-report
- Anthropic, Claude Code best practices: https://code.claude.com/docs/en/best-practices and hooks guide:
  https://code.claude.com/docs/en/hooks-guide
- OpenAI, Codex `AGENTS.md`: https://learn.chatgpt.com/docs/agent-configuration/agents-md; harness engineering as
  reported by InfoQ (the primary post returned 403): https://www.infoq.com/news/2026/02/openai-harness-engineering-codex
- Cursor rules: https://cursor.com/docs/context/rules
- Legacy behaviour reference: the old `@rezics/access` package README (`rezics/libraries/access/README.md`).

Not used because the text could not be retrieved: Robert C. Martin's original *Principles of OOD* and *Granularity*
articles (the SDP and SAP wording above follows the metrics page), and the "functional core, imperative shell" page,
whose text did not render.

## Appendix: reproduction

From the repository root on the measured revision:

```sh
python3 -I .temp/research/imports.py services/kernel/src services/kernel/src --pairs --ext   # modules, Ce/Ca, SCCs
python3 -I .temp/research/imports.py apps/web/src apps/web/src
python3 -I .temp/research/purity.py services/kernel/src services/kernel/src                  # effect-free share
python3 -I .temp/research/clones.py services/kernel/src apps/web/src packages/*/src services/auth/src services/importer/src
python3 -I .temp/research/cycle_path.py services/kernel/src services/kernel/src/http/request.ts
python3 -I .temp/research/brief_paths.py <controller brief store>                            # Goal per module
rg -o --no-filename "from '\.\./access/[^']+'" services/kernel/src -g '!services/kernel/src/access/**' | sort | uniq -c | sort -rn
git log --first-parent --no-merges --since=2026-10-25 --name-status --format= -- 'services/kernel/src/**/*.ts' | cut -f1 | sort | uniq -c
git log --all --since=2026-10-25 --format='%ad %s' --date=short -i -P --grep='(?<!life)cycle\b|circular|before initiali|module init'
```

The scripts are approximations. Imports are parsed with regular expressions; type-only detection is conservative;
modules are first path segments. Once the W1 gate exists, its own graph replaces them as the measure of record.
