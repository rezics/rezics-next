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

Decision: subtract only deleted pricing rows from shared physical counters; preserve unmatched provisional copies
and native reservation keys until native disposal and empty indexed ranges permit reclamation. The migration never
zeros or deletes a generation reservation, and an inconsistent physical count fails its existing constraint.

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
