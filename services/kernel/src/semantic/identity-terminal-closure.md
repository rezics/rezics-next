# Terminal directory and historical redirects

[The native identity contract](identity-epoch-contract.md) owns admission and publication.
The directory remains `identity_epoch_original`; `identity_epoch_mapping` holds the source locator.
There is no second member directory. Native registration, installation, source acknowledgement and
withdrawal records survive a lost command response. A missing, cyclic, moved or unfinished source
is unavailable and retains work; it cannot be replaced by an inferred terminal or self mapping.

## One-hop resolution

S1 supersedes incremental shared closure and transitive withdrawal as the historical-chain solution.
One resumable migration must flatten historical redirects before publishing the one-hop invariant.
Each step seeks a bounded indexed page of redirect heads whose current target is another redirect,
resolves a bounded segment and saves its frontier in the same native transaction as its effects.
A finite chain can require several steps. Missing targets and cycles stay pending without blocking
unrelated candidates. Source-head revisions and owner incarnations must fence every observation
used to change an edge or acknowledge a source. Released read snapshots are not mutation authority.

After migration, structural epochs re-point every original in their resulting groups, including
unselected members, with at most 4,096 originals per group. Publication waits for those native
writes and the fixed participants. Ordinary reads inspect the original's current mapping and its
terminal, with no redirect-chain traversal. Current original and terminal privacy remain independent.

Decision: retain the existing directory and its native recovery interlocks while replacing historical
chain resolution with one bounded migration; remove runtime pricing before replacing those interlocks.
The retained successor-ticket/drain implementation is transitional, not an additional S1 requirement.

## Execution and bounds

Directory phases use the ordinary `runCommand` executor, including authorization, receipt replay,
command deadlines, partition ownership, source hooks, events and native commit callbacks. They do
not require a separate executor profile, a pre-I/O quote, prepaid execution funds or a spent-ticket
ledger. Cleanup uses native retained records, not a second allowance or a refreshed callback grant.
The historical execution-original and spent-ticket tables have no runtime producer and are retired by a forward
migration, together with their bootstrap-page grant/cleanup columns. The directory group's native cleanup flag
remains recovery state. Owner changes still refuse retained native source, export, directory and admission work.

Decision: retire pricing metadata without changing shared generation counters or native reservation keys; only
native disposal and empty indexed reference ranges can reclaim actual or uncertain reservations. Generation counter
writes require the native command and erasure hooks, so schema retirement cannot authorize a counter refund.

Existing structural bounds remain: source export and directory keyset pages contain at most 100
originals; a group contains at most 4,096 originals; its native keyset drain therefore has at most
41 advancing pages. One source attempt selects at most 100 local originals and drains at most 100
distinct groups, so its directory-page ceiling is 100 × 41 = 4,100. Release visits one page per
drained group; unfinished release pages remain native recovery work. The second source attempt
reauthorizes and consumes the exact drain claim, with no ancestor traversal in that transaction.
These are transitional directory bounds, not the migration's composed ceiling.

The four existing generation slots limit retained physical rows independently of execution.
`closure_copies` counts actual or provisionally reserved source, directory and export rows in those
slots. It is not an execution allowance. Release requires exact native disposal plus empty indexed
reference ranges. A failed or uncertain operation retains its reservation and recovery keys.

The migration must state its indexed anchors and segment/page limits, then derive each composed
ceiling by summing the producer bounds. Total job work may follow the finite redirect set; individual
steps cannot scan that set, walk an unbounded chain or rediscover completed prefixes. No fixed
numeric ceiling may prevent a structurally bounded implementation from making progress.

### Selected mapping reads

Decision: fence the current group, directory, registration and redirect joins with selected-key lateral seeks;
reuse the existing primary keys rather than add another directory index. The selected directory key
is `(partition_no, generation, original)`, with generation supplied by the exact requested
`(partition_no, terminal)` group. A flattened join can instead read a growing home/generation prefix
before matching originals. Each lateral `LIMIT 1` preserves that dependency; uniqueness of the full
key, rather than a returned-row limit, establishes the bound. Registration seeks
`(partition_no, transaction_id)` before checking its exact `xmin`. Missing groups stay missing;
missing current-generation directory or registration rows stay null and fail the existing active
mapping evidence checks. An old generation cannot fill an absent selected key.

For an admitted batch of N <= 100 originals, let S and C be its distinct source and control homes,
each at most N. Each of the two independently released collections takes S source snapshots and C
control snapshots. Per collection, source observations use S owner seeks and at most 4N row seeks:
subject, mapping, dirty revision, and latest redirect. Control observations use C owner seeks, N
pending-group seeks, and at most 4N current group/directory/registration/terminal-redirect seeks.
Thus the two collections examine at most `2(S + C + 9N)` visible rows through complete selected
keys (at most 22N), including at most 2N directory entries. Repeated keys may be memoized; they cannot
increase this ceiling. Redirect existence stops at its first indexed `(route, subject_id)` match;
source redirect selection uses that prefix and descending sequence. No redirect chain is read.

An absent subject still costs one exact subject probe; an absent group or directory entry costs one
empty full-key probe, independent of unrelated originals, retained generations or group membership.
Missing registration and redirect keys likewise cost empty probes. B-tree descent follows index
height; ordinary MVCC visibility/vacuum skips are not application retries or a separate meter.
There are `2(2S + 3C)` data statements and `2(S + C)` read transactions, each with BEGIN, timeout
and COMMIT, excluding connection setup. Both collections return at most `2(S + C + 3N)` fixed-width
owner/source/pending/current records: UUIDs, bounded native state tags and fixed-size numeric fields.
Response bytes therefore follow admitted N, never directory population; no arrays of group members,
history, or free text are returned. Double collection and all existing owner, revision, pending-job,
registration/install/export, generation/incarnation and redirected-terminal guards remain intact.
