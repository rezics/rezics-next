# Retained terminal directory

The implementation uses `identity_epoch_original` as a single flattened terminal
membership, and the existing mapping row as a constant-size native locator. It
stores no transitive path or reverse dependency vector. Group capacity remains
4096; each source, pending-source, drain and cleanup keyset page is at most 100.

`stepIdentityEpochBootstrap(pool, partition)` retains its public signature and
native export/receiving/source-ACK order. `stepIdentityEpochBootstrapWork` retains
the topology scheduler. `readIdentityMappings(pool, originals)` preserves input
order, duplicate originals, existing states and the 100-original input bound.

## Native enrollment

`stepIdentityTerminalClosure` performs these released native phases:

1. Recover the exact source export and create its enrollment/hold under its real
   owner and dirty-head lock. Pending source headers take custody from an exported
   transport page, so an unresolved prefix cannot hide a later terminal seed.
2. A terminal seeds itself. A redirected original uses only an active successor
   whose immediate edge, owner and captured head are current. A serialized ticket
   in the successor's existing mapping row prevents an unclassified mutation.
3. Bind the target locator at the source, then enroll a preparing member under
   the terminal group's lock. The entry binds the original, actual source export,
   source generation/head/owner, enrollment and group incarnation. Preparing
   members participate in closing and drain.
4. Commit a nonpositive source install; promote only that exact committed install
   at the terminal; ACK only that promotion at the source. Withdrawal takes the
   same source-row lock as install and ACK. Native phase references include the
   actual executor transaction and transaction version.
5. Finalize the directory reservation and acknowledge only the captured h. A
   later head h+1 remains dirty. Lost responses recover the same enrollment.

A cycle has no terminal seed. Missing subjects, unreadable/moved owners and
unfinished successors remain unavailable; none is interpreted as a terminal.
`advanceIdentityTerminalClosures` revisits pending native source headers by an
independent bounded keyset. Owner-incarnation changes are refused while native
closure or export custody remains; position-only advancement returns before any
dependency query in the owner trigger.

## Close, drain and mutation

`drainIdentityTerminalClosure` closes enrollment under the actual group lock,
walks its frozen generation, and records each real source withdrawal before
advancing its contiguous frontier. Its drained seal binds generation,
incarnation, claim and current dispositions. Legacy members are withdrawn at
their actual sources too; they cannot stand in for a newly installed closure.

`runIdentityTerminalCommand` preserves Core authorization and receipt replay,
uses `withSingleCommandAttempt` for each actual invocation, and releases a failed
discovery transaction before opening foreign drain commands. It keeps the
original request deadline, including Access's five-second deadline. A subsequent
source attempt reauthorizes and `bindIdentityTerminalMutation` consumes the
private exact drain under the same live source transaction as capture. The
trigger refuses an unbound write before advancing a dirty head.

An enrollment that loses the directory lock before insertion is still
nonpositive. A sealed group fences its late registration, allowing its actual
source writer to cancel that hold locally. A source with no chosen directory
can be cancelled under its local lock. Target binding checks that cancellation;
self registration rechecks its source in the same home transaction.

`recoverIdentityTerminalClosure` advances interrupted closing/drained groups,
releases source claims, and invokes bounded cleanup. Cleanup requires native
withdrawal and release dispositions, actual member deletion and an empty-range
proof. A redirected old terminal remains closed. Its claim reservation retires
only after that proof; a surviving terminal receives a new generation and
incarnation before enrollment resumes. Generic admission and publication add an
open-group check adjacent to existing hooks. Rating hooks and consumers are
unchanged; these observations grant no rating transaction authority.

Cancellation retains an outgoing-successor disposition in the existing source
locator. The original's own bootstrap home releases that exact successor ticket
before replacing its enrollment. The cancellation records its real native
producer commit, including for ordinary commands that otherwise emit no
bootstrap receipt. Incoming-ticket and cancelled-source recovery have separate
advancing keysets; an unresolved first page cannot hide later recovery work.

## Physical allocation and remaining implementation work

`reserveIdentityTerminalClosure` delegates to the existing private
`reserveGeneration`, with its four slots and 4096-copy ceiling per slot.
Provisional source, successor, page and receiving copies coalesce into that
inventory; distinct exports keep their individual receipt identities. Closing
reserves a separate exact claim liability before changing group state. Release
checks actual source, ticket, page and directory references, as well as counters.
This is physical allocation, not execution funding.

The complete contract is not yet implemented. In particular, this source does
not install authentic finite eight-axis original frames, durable debit/spent and
no-refill replay state, or complete private parent transfers for every listed
producer/workflow. No literal inclusive SQL/body/framework/authorization/receipt/
callback/failure/rollback cost derivation has been established. Unsupported
provisional numeric costs were removed instead of being presented as funding.
`NativeStepWork` remains reporting only. The full cohome/crash accounting proof
for phase receipts, workflow/accounting records and old/new output coexistence
is also outstanding. Mapping member effects and Access delivery/birth funding
are not complete. These are owned implementation obligations, not missing
foreign permission or another research question.

Native, growth, default-worker, legacy, RLS and full acceptance execution remains
deferred. The new cases are authored obligations, not passing evidence.

## Source inventory and verification disposition

The production entry points are:

| File | Implemented callables and integration |
| --- | --- |
| `identity-terminal-closure.ts` | `stepIdentityTerminalClosure`, `advanceIdentityTerminalClosures`, `drainIdentityTerminalClosure`, `bindIdentityTerminalMutation`, `cancelUnregisteredIdentityTerminalCapture`, `releaseIdentityTerminalClaim`, `recoverIdentityTerminalClosure`, `cleanIdentityTerminalClosure`, `retireIdentityTerminalPage`, `assertIdentityTerminalGroupsOpen` |
| `identity-terminal-closure-command.ts` | `runIdentityTerminalCommand`, `admitIdentityTerminalCapture`; released discovery/drain/mutation sequencing, without authentic funding |
| `identity-epoch-bootstrap.ts` | Existing bootstrap signatures call native recovery and pending-source progression, then export, receiving and separate source ACK; physical page reservation precedes allocation |
| `identity-epoch-mapping.ts` | `reserveIdentityTerminalClosure` uses the existing private `reserveGeneration`; it does not supply execution funding |
| `identity-epoch-read.ts`, `identity-terminal-closure-current.sql` | Existing ordered mapping read joins each requested original's exact current terminal directory entry |
| `identity-epoch-admission.ts`, `identity-epoch-admission-hold-source.sql`, `identity-epoch-store.ts` | Immediate-source compatibility and additive closure-open admission/publication checks, adjacent to unchanged rating hooks |
| `subject.ts`, `bulk.ts`, `account-agents.ts`, `merges.ts`, `merge-moves.ts` | Actual command invocations use the single-attempt wrapper; subject write, birth, ordinary merge and merge-member mutations call native capture admission |
| `../access/agent-verification-identity.ts` | Four actual identity admission/binding commands use the wrapper; delivery and account-agent birth original funding remains incomplete |

Both forward migrations, `20261102000100_identity_terminal_closure_fresh.sql`
and `20261102000200_identity_terminal_closure_fresh.sql`, and the Semantic schema
snapshot contain the new constant-size locator, directory states, native phase
references, recovery cursors, indexes, capture interlock and owner guard. The
existing Core partition trigger and historical migrations are unchanged.

The implementation makes the following literal structural bounds. These are
**not** inclusive execution prices or evidence of authentic admission:

| Operation or inventory | Literal bound |
| --- | --- |
| Source page, pending-source page, each recovery keyset | 100 originals per page |
| Requested mapping/control page | 100 originals |
| Directory membership | 4096 originals per group |
| Drain keyset and cleanup deletion | 100 originals per page |
| Synchronous drain of one admitted group | 41 advancing pages |
| Successor discovery | One immediate successor per source enrollment |
| Shared extra-generation inventory | Four slots, at most 4096 charged copies per slot |

No complete literal table exists for `candidateKeys`, `nativeRows`,
`identityMetadataRows`, `emptySeeks`, `nativePoints`, `witnessKeys`, `statements`
and `bytes`. Native command framework, authorization, arbitrary callbacks,
failure/rollback, retained continuations and cleanup have not been composed into
a prepaid original. The new funding test file covers physical reservations; it
does not yet test an installed original frame or durable no-refill semantics.
No genuinely missing external operand has been identified. The missing funding
and complete accounting are this implementation's own obligations.

The sole permitted compiler invocation was
`bun run --cwd services/kernel typecheck --emit-schema=semantic`. The configured
placement ran on host `b` and terminated with exit status 2:

```text
src/semantic/identity-terminal-closure.ts(604,11): error TS18047: 'current' is possibly 'null'.
src/semantic/identity-terminal-closure.ts(604,71): error TS18047: 'current' is possibly 'null'.
```

The source now explicitly rejects a null `current` before using the ticket
reservation. The one-invocation policy prohibits a second compiler run. Later
cancellation-recovery and schema edits are also unverified. Schema emission did
not occur after the failed compiler; the snapshot was updated from the two
forward migrations. This is a failed typing receipt with a committed fix, not a
passing receipt. All native/unit/growth/full acceptance remains UNRUN. The frozen
contract test and existing acceptance assertions were not edited. No file
outside the declared paths was changed.

## Reference sources

The selected directory protocol follows the pending-fill invalidation ordering
in the [UBC MSI model](https://www.cs.ubc.ca/~ajh/courses/cpsc513/2005/assign_msicache/protocol.html).
PostgreSQL's retained `src/backend/utils/time/snapmgr.c` explains snapshot
lifetime; released snapshots do not become cross-home mutation authority.
The retained DBOS `src/dbos-executor.ts`, `runInternalStep`, executes its callback
before checkpointing its result, motivating native receipt recovery after a lost
response. The retained implementation branch had no terminal-closure module;
its bootstrap/read/mapping/caller/schema paths and earlier tests were reference
material, not installed closure authority.
