# Vote command template status

The owner schema is in Access migrations 070–073 and the vote model profiles.
`access.ts` writes an immutable admission proof beside `access.admission`; `graph.ts`
commits a guarded graph update, receipt, sequence and outbox batch in one Jena
transaction. `admitted.ts` resolves an uncertain dispatch by the graph receipt
before sealing the Access admission. An unresolved outcome returns a pending
operation identity for retry with the same idempotency key.

`commands.ts` is the first command template. The poll preparation path writes
the charter, question, options, snapshot and source entitlements together.
`read.ts` reads the resulting poll. Copy the admission, guarded write, receipt
and read structure from these files for another vote operation. An HTTP route
still needs the Access vote adapter wired through Main's dependency composition.

## Cost contract

Poll preparation accepts at most 1,000 entitlements and 64 options. It makes
one bounded Access identity query, one Access admission transaction, one graph
write and one graph receipt read. A poll read uses one graph query whose result
is bounded by those option and seat-class limits. Allocation accepts at most
1,024 leaves and checks the current poll, root and all existing counting slots
in the guarded graph write. Ballot change reads one poll, seat, charter and
ballot head; tally reads current ballot heads plus their shares, O(current
ballots + current shares). Those query bounds and index plans still require a
live workload check before acceptance.

The command code is a partial implementation. The HTTP template, integration
tests for admitted write/read, Access-policy races, graph concurrency and
recovery replay remain open. No GOV acceptance ID is declared from these files.
