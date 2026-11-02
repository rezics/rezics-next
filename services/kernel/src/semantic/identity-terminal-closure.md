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
