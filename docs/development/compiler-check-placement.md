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
failure-status and cleanup behavior. SQL content mappers and the selected tsconfig are unchanged. A workspace whose tsconfig names a content mapper declares that mapper's package itself, so the mapper resolves from that workspace (Web declares `reylo` 0.7.0 in `devDependencies` only, beside its `contentMappers` entry).

Decision: Web's official typecheck and check gate both execute `tsc --noEmit --runExternalCode` for `tsconfig.json`
then `tsconfig.scripts.json`. The scripts program still runs after a red web program. The check gate does not
substitute `bun check --no-script`. Pin with `apps/web/scripts/typecheck.test.ts`. Native, browser and full root
journeys remain separate acceptance.

Repository-relative `REYLO_CONFIG` is a bounded explicit `--reylo-config=` argv input, revalidated by the receiving
entrypoint. Paths resolve from each selected SQL workspace and must remain inside the checkout. External/absolute
projects are explicitly unsupported. Kernel's core or existing module `--emit-schema=` modes declare their bounded
schema.sql returns. Disposable compiler analyses are consumed within the same run, not returned recursively.
`--emit-client` declares the closed [Kernel client output profile](../../services/kernel/README.md#client-declaration-output-placement).
Its bounded versioned bundle uses the existing physical return pipeline. Source, attempt and complete byte custody
must validate before whole-tree publication, including deletions. Already admitted direct execution and nested placement
use that same profile; external projects remain unsupported.

## Execution failure classification

Decision: Root, Kernel and Auth classify placed host statuses 75, 124, 130 and 143 as infrastructure status 75,
retaining the raw host status and `phase=placement` in diagnostics. Other placed statuses and ordinary compiler
statuses remain native. Exceptions at placement, database setup and executable launch are infrastructure failures,
not compiler diagnostics. Direct wrappers report `placement`, `database-setup`, `compiler` or `database-cleanup`;
Kernel output publication has its own phase. Ordinary cleanup still runs after compiler failure, verifies container
and volume settlement, and reports that error beside the original compiler identity without replacing a completed
native status. Invalid external configuration continues to fail validation before any placement or database starts.

The existing direct-wrapper acceptance in `scripts/typecheck-placement.test.ts` pins these cases with inert
placement, database and compiler boundaries. Its old Auth executable-launch assertion expected a rejected promise;
it now expects status 75 while retaining the original cleanup assertion. Placement-path units inject a refusing
recognizer so they still relocate when the suite itself runs inside a check-host checkout. Composition fixtures that
call `runOnCheckHost` also inject that recognizer and a fake remote so nested-candidate refusal does not fire against
the admitted checkout. Compiler diagnostic assertions unset `REZICS_CHECK_PHASES` so observation lines do not mix with
tsc stderr. Compiler diagnostic/status,
selection, output and physical admission assertions remain unchanged. Native, browser and full root journeys remain
separate acceptance; focused execution does not establish them.

Decision: `scripts/check-startup.ts` is the combined startup selection: migrated compiler database for Auth
composition, project Go Task on PATH, inert SQL-analysis/admission seams so native 23 reaches the fake compiler,
placed 124/130/143 as infrastructure 75 with raw status and placement phase, heartbeat SSH reaped before results,
and `--acceptance` keeping live root plus Auth native/browser suites. Both Web programs stay mandatory. Pin on the
existing suites plus `scripts/check-startup.test.ts`. Fewest tests: those existing placement, compiler-database,
check-startup and Auth config assertions already pin native 23, placed 75/124/130/143, Auth Task/DATABASE_URL,
ordinary cleanup settlement and detached signal cleanup; add no extra suite. Typecheck repair updates Follow,
contribution-story, public-scope walk and Auth retirement fixtures to current contracts; those assertions stay. Ordinary compiler-database cleanup
waits for `docker rm -f -v` then inspects the container and labelled volume gone; that error stays beside native
0/23 and does not become 75. Root's shared-database cleanup uses the same keep-status rule, and its SIGINT/SIGTERM handlers pass `wait=false` into that removal. spawnSync removal waits
in-process; only SIGTERM/SIGINT uses `beginDetachedDockerRm` so a 200ms SIGKILL cannot abort it. `docker run` retries once after spawn
timeout and nonce reap; that failure stays 75. Labelled reap lists (`ps -aq`) use the run timeout. Combined units
run after landing.

Decision: receive Search's unchanged default heap and explicit heap/container overrides, additive account messages
and History's distinct local/full native module assertion through the combined selection. SSH retirement requires
an affirmatively dead listener under the same exclusive lock that acquisition holds shared; a control-check timeout
remains uncertainty. Home and VN Realm register resources immediately and await every independent cleanup while
retaining the primary error. Their original positive walks remain in `--acceptance`. The existing upload move and
stale-directory sweep remain authoritative; the linked receiving correction cancels additional durable move state.
The Web received-value label needs only a subject identity, matching its existing caller and runtime behavior.

Additional sources: the integrated Search/History, History semantic return, Web compiler/settlement and integrated
startup receiving decisions, their linked upload-move correction, and the installed Search, History, Web and SSH
callers and tests. Regression changes distinguish affirmatively dead listeners from uncertain control checks;
the existing native/compiler assertions remain intact.

The combined Kernel selection also executes History's real Semantic source-set declaration, seal callback and event
copy association. Positive cases require the installed producer; an unavailable-producer branch cannot establish a
native pass. Receive its existing fixture correction: native begin owns the sole declaration, registered seal work
requires an event, and a digest mismatch uses a well-formed digest. History's owner prose remains with its owner.

Sources for this repair: this placement contract, Scripts, verification and local-stack owner runbooks, the two
contract-linked receiving decisions, the installed compiler/transport fixtures and Auth startup callers, and the
read-only reference index. Go Task's [official installation guidance](https://taskfile.dev/docs/installation) supports
a project dependency whose installer verifies the downloaded binary checksum. Frozen-install identity checks the
public `bin/task` once with a 30-second bound; Bun store copies of the same package are not executed, and the 5-second
Docker probe window does not apply. No product authorization boundary changes.

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

The one bounded unit invocation, `bun test scripts/root-typecheck-placement.test.ts scripts/typecheck-placement.test.ts`,
ran at implementation commit 30d0d76ae5: exit 1, 41 passed, 2 failed, 457 expectations, 5.08 seconds. All 26 direct
wrapper tests passed. The new root diagnostic test incorrectly required stdout/stderr adjacency despite native Bun
script-launcher lines; it now asserts the complete original block including those lines. The new root/direct
composition fixture returned 1: its package launcher could prepend real ancestor executable directories ahead of the
fixture PATH. The receiving fixture now confines both process and child executable lookup to its inert bin directory.
That first fixture did not establish exclusively fake compiler execution; it must not be reported as a pure compiler
or physical proof. Database preparation was injected throughout. No database or remote transport was intentionally
started by these units. The corrections were committed; the bounded invocation was not repeated. The final root
fixture corrections and the untouched live relation acceptance remain unverified by execution.

Required foreground workspace typing ran sequentially from the worktree root at source commit 2ee6a0f9ae, using the
supported placement and existing foreground session handles until each terminal result:

| Command                                   | Host | Terminal status | Remote command duration | Reported peak memory |
| ----------------------------------------- | ---- | --------------- | ----------------------- | -------------------- |
| `bun run --cwd services/kernel typecheck` | b    | 0               | 361.939 s               | 9180 MiB             |
| `bun run --cwd services/auth typecheck`   | b    | 0               | 332.244 s               | 5073 MiB             |

Kernel's receipt includes `bun scripts/construct.ts`; Auth's includes its compiler database owner message. Both runs
used the normal producer and physical receiving code, not injected evidence, local/off overrides or a replacement
compiler. The unchanged source continued in the admitted run and returned zero. Neither command has a detached check
ID. No original stopped consumer was started or retried, and neither compiler was interrupted or duplicated.

These are actual direct-workspace typing receipts, separate from the authored acceptance. They do not prove root
selected-workspace relocation on a physical host, schema/client output transport, the existing live relation
acceptance, historical consumer failures or full native/browser behavior. Original acceptance/native/browser
verification, stopped consumer retries and Goal closure remain deferred. The final receipt-only documentation commit
does not change the typed source.

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

The read-only shared scripts/README.md still contains a superseded Auth URL-bypass sentence in its check-host section;
this launch contract and the compiler policy above govern the entrypoints. That shared transport document was left
closed alongside the producer/placement files.

## Bounded launch and preparation

Official remote launches carry the generated command/source envelope on SSH stdin. Only a fixed Python receiver,
byte length and SHA-256 digest occupy the SSH command argument. The receiver accepts at most 1 MiB, requires the
complete exact-length digest before execution, and executes an anonymous script file with command stdin closed.
The lifetime monitor and systemd scope execute run-owned script files, so moving bytes off SSH argv does not merely
move E2BIG to another process boundary. The original command arguments, source checks, run identity, physical terminal
receipt, cancellation, output-tree receiving (including deletion) and verified run-directory cleanup still apply.
The 1 MiB bound is a launch-input bound; existing command/source and output limits remain unchanged.

Preparation keeps its absolute three-minute deadline. Bounded failure diagnostics add `stalledPhase`,
`phaseElapsedMs` and up to 16 owned process PID/state/kernel-wait records to the existing infrastructure failure.
The last phase is atomically recorded under run scratch before base refresh, runtime verification/download,
Git restoration, source validation, source/native cache locking/verification, frozen installation, publication and
restore. Both the stream supervisor and independent lifetime monitor capture evidence before reaping descendants;
no command arguments or environment values enter these diagnostics. Empty package observations remain unknown.
Historical SSH/disk/memory observations do not identify the cause of a preparation stall; flock/rsync contention
requires actual phase/wait evidence. A preparation failure remains compiler-not-started, never a typing result.

Decision: use a bounded length/digest-verified stdin envelope and run-owned script files; diagnose preparation with
phase/wait evidence while retaining the existing deadline and controller recovery protocol.

The Web focused adapter selects a separate clean committed driver with `WEB_CHECK_DRIVER_ROOT`. Its head must already
be an ancestor of canonical dev in the same Git repository. Controller integration must precede selecting the corrected
snapshot and resuming existing sessions. Preserve unrelated dirty checkouts; create a separate clean snapshot instead.
Expired preparations require controller repair/replacement before fresh preparation under the original session/check
protocol. Queued recoveries and failed run identities remain intact; no repeated consumer or compiler producer follows
from unit tests. Rating's coherent increment proceeds through ordinary controller landing guards, with its verification
limitation retained. Consumer/native/browser acceptance and physical host diagnosis remain controller follow-up work.

Sources for this correction: the linked Performance and worker-autonomy owner documents, agent conduct, this placement
contract, the integrated bounded-output commit, remote-check/check-run implementation and fixtures, and Web focused
placement's clean-driver selection. The reference index names no upstream source for this transport surface.
