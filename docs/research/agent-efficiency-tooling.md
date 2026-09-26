# Agent-efficiency tooling re-evaluation

Checked 2026-09-26 and 2026-09-27. The maintainer asked whether tools excluded
from the first phase, such as go-task, or tools not yet considered would make
agent batches faster now. This record explains the decisions; the
[toolchain lock](../development/toolchain.md) owns the adopted versions and
commands.

A candidate qualified only if it plausibly removes agent time, tokens or repair
cycles from the [batch cadence](../plan/execution-workflow.md#batch-cadence).
It also had to run on the pinned Bun 1.4.2, Yarn 4.18 with build scripts
disabled, and TypeScript 7 stack, add no daemon or service, and take an exact
pin. Savings were not measured before adoption. The review judged that Goal batches lose agent time mainly to choosing and
rerunning tests, reading test output, rebuilding images and repairing defects
found late, rather than to running commands.

## Adopted

| Change | Problem it removes | Evidence on adoption |
| --- | --- | --- |
| `yarn test --affected` over the existing dependency-cruiser graph | Agents chose test files by hand, which misses indirect importers, or reran whole tiers to be safe. | The full backend graph and plan take about 1.6 seconds. The rules are in the [harness](../testing/test-harness.md#affected-test-selection). |
| Compact Bun output (`AGENT=1`) for direct `yarn test` runs | Passing test names filled agent context. | Bun prints only failures and the summary in agent mode ([Bun test](https://bun.com/docs/test)). QA tiers strip the variable, because a killed tier would otherwise leave an empty log. |
| Content-addressed Fuseki image tag | Changed shapes or modules needed a hand-made tag suffix, because this host serves stale images for a reused tag. | `yarn gen` stamps the tag and `gen:check` catches an unstamped change. Adoption also fixed the load image parser, which had rejected the `-scalar1` tag and broken `stack:clone`, `fixture:restore` and `yarn load` since that tag was adopted. |
| oxlint type-aware promise rules | An unawaited promise fails far from its cause, often only under load or restart. | The first run fixed 20 findings, including Main's shutdown. Biome's nursery rules missed `pg` and Drizzle cases in a probe ([oxc](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable), [Biome rule](https://biomejs.dev/linter/rules/no-floating-promises/)). |
| Knip | Dead files and dependencies accumulate across parallel workers and mislead later briefs. | Zero unused files or dependencies at adoption, so the gate is strict from the start; exports are a report ([Knip v6](https://knip.dev/blog/knip-v6)). |
| ast-grep | Module boundaries such as "modules receive handles and configuration" existed only in prose. | Five rules with fixture cases; the scan covers 534 files in 0.15 seconds ([scan](https://ast-grep.github.io/reference/cli/scan.html)). |
| Schemathesis | Hand-written API tests cover the paths their author imagined. | The first pass found that Main returned 500 for unknown routes and that the contract carried 19 tuples invalid under OpenAPI 3.1; both are fixed ([CLI](https://schemathesis.readthedocs.io/en/stable/reference/cli/)). |

## Not adopted

| Candidate | Reason | Revisit when |
| --- | --- | --- |
| Task/go-task | Its value is skipping file-fingerprinted steps. The only long cacheable step, the Fuseki image, is now content-addressed; the Yarn facade already serves as the one command surface. | Several long, cacheable build steps exist, or `toolchain:install` becomes a measured bottleneck. |
| Nx, Turbo, moon | Task graphs and caches work per workspace; backend tests run through shared QA stack tiers instead, so workspace-level affected detection selects too much. | CI time is dominated by independent per-workspace builds. |
| mise | `toolchain:install` already checks the Bun, Node and Docker versions; oracle toolchains are pinned by archive digest. | The product needs more host runtimes than those checks cover. |
| Lefthook | Hooks on every commit would slow Goal worker commits in worktrees and duplicate the manager's once-per-wave checks. | Commits with failing static checks reach `main`. |
| `bun test --changed` as the selector | It follows only unit-test imports. It ignores the QA stack tiers, data files, migrations and the Fuseki image. | Not applicable; it remains usable for a single unit file loop. |
| oasdiff, Spectral | The OpenAPI document is generated from route schemas and has one in-repo consumer, the Eden type gate. | An external client or published SDK depends on the contract. |
| PGlite | Integration tests depend on real PostgreSQL 18.6 roles, triggers, WAL and `pg_basebackup`. | Pure SQL unit tests appear whose container startup dominates their run. |
| Drizzle v1 release candidate | The adopted 0.45.3 slice is stable; a release candidate is not an exact long-lived pin. | Drizzle v1 is stable. |
| Testcontainers | Already not used; the harness drives Compose directly. | Unchanged. |

## Deferred work

A bulk fixture builder that loads TDB2 with `tdb2.tdbloader`, rebuilds Lucene
with `jena.textindexer` and loads PostgreSQL with `COPY` would replace
command-created corpora for large fixtures. It must first verify that the pinned
image carries the TDB2 commands and preserve the owner receipts that restore
checks compare. `services/main/src/app.ts` has grown to about 5,500 lines, so
splitting it by operation family would shrink the context each worker must read.
That split is a refactor, not a tool.
