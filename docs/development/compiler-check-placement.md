# Compiler entrypoint placement

Root `bun scripts/typecheck.ts`, Kernel `bun run --cwd services/kernel typecheck` and Auth
`bun run --cwd services/auth typecheck` share one physical admission boundary. SQL-mapped compiler work, including
database preparation and Kernel construction, runs only on approved hosts a/b. Missing hosts, native nonzero exit,
transport status 75 and cancellation are terminal results; none authorizes local replay. Local/off environment
markers do not change this rule.

`recognizeCheckHostRun` checks the entrypoint's own source directory using the existing
[physical receiving predicate](check-host-recognition.md). Root overrides, database URLs and environment markers
cannot select its evidence. Admitted execution continues inside the same run without another host admission. The
optional recognition/placement/database dependencies are inert test seams, never environment configuration. A null
placement response without physical recognition is refused with status 75.

The root entrypoint computes affected workspaces and their transitive dependent closure before admission. An empty
selection returns zero; selected pure workspaces execute locally without host or database work. A selection containing
SQL work relocates in its entirety before any database or workspace process starts. The remote command carries a
versioned JSON `--selection=` argv element with the exact changed-file list, or null for all workspaces. This preserves
both `TYPECHECK_CHANGED` and the programmatic changedFiles option. Decoding accepts only the two declared fields,
version 1, at most 4096 relative paths of at most 4096 characters and at most 65536 encoded bytes. Control characters,
absolute paths and traversal segments are rejected. Empty lists and an absent list remain distinct. Arguments are
data, never shell commands or evaluated code. Arbitrary source-root overrides are unavailable for production SQL
runs; the source checkout and its pinned Bun continue to own execution.

An explicit developer `DATABASE_URL` is used unchanged only within already admitted custody. Outside that custody,
status 75 explicitly refuses relocation: the current producer has no declared safe representation for these precise
credentials and SQL semantics. It neither copies credentials nor substitutes a fresh database. A normal admitted
root run prepares one database with both schemas, shares it with the selected workspaces and removes it after all
consumers finish. Direct Kernel and Auth retain their existing migration, SQL analysis, construct, diagnostic,
failure-status and cleanup behavior. SQL content mappers and the selected tsconfig are unchanged.

Repository-relative `REYLO_CONFIG` is a bounded explicit `--reylo-config=` argv input, revalidated by the receiving
entrypoint. Paths resolve from each selected SQL workspace and must remain inside the checkout. External/absolute
projects are explicitly unsupported. Kernel's core or existing module `--emit-schema=` modes declare their bounded
schema.sql returns. Disposable compiler analyses are consumed within the same run, not returned recursively.
`--emit-client` has no bounded declaration-tree return contract: an unadmitted caller receives the existing explicit
file-retention refusal rather than successful artifact preservation or local execution. An already admitted run may
consume its own emitted files. No new arbitrary absolute path, credential forwarding or unbounded return support is
introduced.

## Authored acceptance and execution receipts

The root composition regression was committed before implementation. It exercises the real selection and database
branches and composes both direct wrappers with fake compiler executables. Placement, database and physical evidence
are inert fixtures. Coverage includes a/b filtering through the real placement helper, native statuses and cancellation,
forged markers and explicit URLs, one database through SQL/construct and cleanup, exact diagnostics, pure dependent
closure, empty selection and bounded input rejection. Existing compiler diagnostic/output/cleanup assertions retain
their checks under injected physical admission instead of their obsolete environment-only bypasses.

The canonical three-file acceptance command is **UNRUN** under the current source-only execution policy: original
acceptance is deferred, and scripts/typecheck.test.ts still includes the existing real Docker/PostgreSQL relation
acceptance. That assertion has not been weakened, removed or relabeled as mocked proof. Only explicitly bounded
database-free unit invocations and the required foreground workspace typing are eligible during this attempt.

Receipts will be recorded here after the committed implementation is checked. Authored acceptance does not establish
successful physical receiving recognition, real compiler/SQL correctness, migration correctness, or retained-output
transport. Original acceptance/native/browser verification, stopped consumer retries and Goal closure remain deferred.

## Scope decisions and source reading

The explicit URL policy chooses unsupported relocation rather than inventing a credential producer interface. The
selection descriptor carries changed files rather than guessed workspace names so dependency closure remains the
entrypoint's existing authority. A full descriptor overrides destination-side selection environment. Config input is
explicit argv because the producer deliberately leaves caller environment behind. No transport/producer/gate/control
plane/release files were changed.

Read the manager's performance instruction and approved-run-recognition normal-result decision, the receiving
predicate and stack-run/remote producer interfaces, root compiler/database code, both direct wrappers and workspace
commands, repository workflow and Goal definitions. The reference index was inspected; no cited upstream reference
source governs this entrypoint repair and no new external research was required.

Outside the seven declared paths, services/kernel/README.md and services/auth/README.md change only their command
paragraphs: they previously promised environment-only execution and local fallback, contradicting the repaired
entrypoints. They now point here for compiler policy.
