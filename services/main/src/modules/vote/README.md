# Vote command template

The owner schema is in Access migrations 070–073 and the vote model profiles.
`access.ts` writes an immutable admission proof beside `access.admission`; `graph.ts`
commits a guarded graph update, receipt, sequence and outbox batch in one Jena
transaction. `admitted.ts` resolves an uncertain dispatch by the graph receipt
before sealing the Access admission. An unresolved outcome returns a pending
operation identity for retry with the same idempotency key.

`commands.ts` contains the guarded graph writes. Poll preparation writes the
charter, question, options, snapshot and source entitlements together. The
routes in `routes/polls.ts` expose writes and reads through Main. For another
vote operation, copy the request schema and error mapping there; add its Access
proof in `access.ts`, preflight and replay in `admitted.ts`, guarded write in
`commands.ts`, and bounded read in `read.ts`. Every new action needs a family in
`receipt-family.ts`. A retry checks the immutable admission and graph receipt
before reading mutable poll, charter or ballot heads.

## Cost contract

Poll preparation accepts at most 1,000 entitlements and 64 options. It makes
one bounded Access identity query, one Access admission transaction, one graph
write and one graph receipt read. A poll read is bounded by those option and
seat-class limits. Allocation accepts at most 1,024 leaves and checks the
current poll, root and counting slots in the guarded graph write. Opening reads
the frozen seats once and guards against any later activation before commit.
Ballot change reads one poll, seat, charter and ballot head; approval checks
one candidate and one principal counting slot. Tally reads current ballot heads
and their shares, O(current ballots + current shares). The governance workload
check remains an integration-wave task.

`tests/qa/integration/poll-template.test.ts` exercises the real Access and Jena
write/read path, lost-seal recovery, allocation/opening races, ballot replacement,
independent approvals and internal resolution aggregation. Until G-087 exposes
governance OAuth scopes, the routes use `access:manage` and `access:represent`.
