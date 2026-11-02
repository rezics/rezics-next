# Retained redirect closure: coordination research boundary

The installed bootstrap is not terminal-closure authority for a historical
redirect chain. It exports the current direct redirect target, receives that
payload at the target's home, and acknowledges the captured source revision.
The mapping reader correctly refuses a mapping whose target is not consistent
with its direct source edge. Replacing that refusal with acceptance of a distant
terminal, without installing intermediate currentness custody, would introduce
stale positive observations.

The retained branch has no `identity-terminal-closure.ts`. Its matching
bootstrap, read, mapping, caller and schema paths contain the installed direct
edge implementation. Its terminal-closure document and earlier native tests are
reading material, not an installed dependency receipt or production producer.

## Existing native boundaries

- `stepIdentityEpochBootstrap(pool, partition)` retains at most 100 source rows
  in a page. Export, receiving and captured-head source acknowledgement are
  separate native commands. The source client is released before receiving.
- `stepIdentityEpochBootstrapWork(pool, schedule?)` advances the native topology
  frontier and delegates to that source protocol. Empty-home closure also keeps
  three distinct native commits.
- `readIdentityMappings(pool, originals)` limits input to 100 originals and
  collects source and control evidence in separate home-local snapshots. Its
  repeated collection is an observation check, not a writer interlock for an
  intermediate redirect that is absent from the collected evidence.
- `capture_identity_epoch_key` locks and advances the affected key's dirty head.
  It does not enroll or withdraw intermediate dependencies for other originals.
  The four source triggers delegate to this function.
- `guard_identity_prearm_owner` protects existing prearm/source-hold custody. It
  does not currently protect a terminal-closure incarnation. Position-only
  advancement must keep its existing lack of dependency work.
- Private `reserveGeneration` uses the existing four-slot
  `identity_epoch_mapping_generation` relation. No terminal-closure allocation,
  path membership, inverse enrollment or cleanup reservation is installed by
  this document.

The source ACK updates `captured_revision` to the exported head rather than to a
newly observed head. That property must survive a new closure protocol. It does
not, by itself, prove that an intermediate edge still belongs to that export.

## Question requiring research

Which established incremental graph or distributed dependency protocol can be
adapted to the following combination, with a concrete retained-state layout and
an inclusive per-transition cost derivation?

1. Arbitrarily long stable cross-home chains advance through retained, bounded
   steps, with an actual terminal witness. Each intermediate edge and terminal
   is bound to its captured native head and owner incarnation.
2. An intermediate writer withdraws every affected published or preparing
   observation before its new edge can be authoritative. Enrollment and
   withdrawal serialize at their actual homes. No transaction holds a second
   home's connection, and no trigger recursively visits all dependents.
3. Receiving and source acknowledgement cannot accept a withdrawn incarnation,
   including enrollment races, lost responses, owner ABA and publication races.
4. All provisional, frontier, visited, dependency, receiving, workflow and
   cleanup copies reserve capacity before allocation in the same four-slot
   physical ledger. Retired and abandoned copies remain charged until actual
   custody permits their release.
5. Every real original owns a finite execution frame. Parallel and nested work
   transfers that frame, and replay, failed dispatch and rollback cannot refill
   it. Mutation writers cannot borrow an earlier bootstrap's allowance.

The unresolved choice is the dependency representation and its reclamation
protocol, rather than whether the listed owned admissions are authorized. Those
admissions and the source/capture/receiving bodies are implementation work in
this repository; they are not claimed to be absent foreign permissions.

## Why the straightforward alternatives are insufficient

A retained path per original makes traversal resumable and cycle detection
straightforward, but duplicates shared suffixes. For a chain of `n` originals,
retaining every original's complete suffix produces `n(n+1)/2` node witnesses.
The per-home retained excess is then quadratic while the allowed membership
baseline grows linearly with the originals plus the fixed four-slot excess.
A response page limit does not fix that retained-state growth.

Sharing a closure for each intermediate key avoids those duplicated suffixes,
but moves the problem into invalidation. For `A -> B -> C`, a dependency from A
to B must protect B's closure incarnation, including changes to C that leave
B's direct edge unchanged. Marking only C or only B dirty cannot authorize a
positive read of A. A deferred invalidation queue needs a native writer interlock
and complete transitive withdrawal custody; queue delivery alone is insufficient.
A cached child's terminal or a released reread of its receipt is insufficient.

Freezing all enrolled keys until a later writer drains dependents can establish
an interlock, but requires a retained, funded withdrawal frontier that itself
fits the physical ledger. The protocol must specify recovery from an interrupted
writer, concurrent enrollment, shared suffixes and cleanup. Permanently refusing
all writes after enrollment does not provide eventual stable progress.

Neither alternative is adopted here. Selecting one without a complete storage,
withdrawal and reclamation argument would move an unproved assumption into the
authorization path. The repository architecture requires evidence for a custom
mechanism and comparison with established alternatives. That protocol research
must precede production enrollment and positive publication.

## Reference observations

The PostgreSQL reference source
`search-canonical-coverage/postgres/src/backend/utils/time/snapmgr.c` describes
snapshot lifetime and transaction-local visibility. It does not make released
snapshots into a cross-home writer fence.

The DBOS reference source
`search-worker-outcome-harness/dbos-transact-ts/src/dbos-executor.ts`,
`runInternalStep`, runs the callback before recording its operation result.
Consequently, losing a response after a native commit requires recovery from the
native ledger. Absence of the SDK step result cannot authorize repeating a
physical allocation or refilling an original's frame.

No terminal-closure producer, positive read exception, native owner bypass,
second physical ledger or change to a frozen assertion is installed here. The
frozen cross-home regression and the full original acceptance remain unrun.
