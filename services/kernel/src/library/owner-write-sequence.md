# Native owner write sequence

[Owner state-write order](../../../../docs/library-and-collections.md#owner-state-write-order) owns behavior. This module owns the allocator ABI, private counter and sequence columns, and the integrated producers that stamp them.

The exact ABI is `allocateOwnerWriteSeq(tx: CommandTransaction, accountId: string): Promise<bigint>` from `owner-write-sequence.ts`. It requires a live native authorized execute body, that owner's account attribution and actual matching partition. Invalid routes, wrong homes and expired/copied transactions fail before SQL. This trusted helper supplies no permission or connection: commands retain ordinary owner admission/scopes and `shareAccount` before receipt lookup. Callers cannot select a sequence.

Migration `20261028182526_owner_write_sequence.sql` adds private `library.owner_write_counter`, primary key `(route, account_id)`, and nullable private bigint `owner_write_seq` on live `library.entry` and retained `library.entry_deleted`. Present sequences are positive; null means genuinely legacy/unsequenced. There is no default/backfill. Existing constraints, pins, incarnation/archive fields and source hooks are unchanged; no fact copies, membership witnesses or per-state caches are added.

First authorized state mutation inserts the owner's internal zero counter with `ON CONFLICT DO NOTHING`, then executes `UPDATE ... SET seq = seq + 1 ... RETURNING seq` in the same transaction. Only positive bigint escapes, without Number conversion, max scan, reset or wrap. PostgreSQL overflow aborts. Native receipt replay skips the body. A no-op command callback only rejects `noEffect` after allocation; it supplies no ordering. Domain exceptions and failed/CAS/denied/occupied/expired operations must abort the entire fact transaction, rolling back initialization/increment, fact, receipt and outbox. Never catch a failed domain result and commit it. Successful state set allocates even for an equal value; equality is not receipt replay.

Integrated producers allocate on that same authorized command after ordinary admission:

- `putEntry` (`library.entry.put`) stamps the allocated sequence onto the live row after insert or state update.
- `deleteLibraryEntryInTransaction` (`library.entry.delete`) archives the live row with its original sequence, then records the new sequence in original-keyed `entry_clear` with physical deletion. Clear preserves the adopted retained/physical-delete response contract and creates no sequence tombstone.
- `restoreEntryState` (`library.entry.state.restore`) is Undo: it allocates a fresh sequence and stamps the restored live row even when native state, pin and dates match the snapshot.
- `restoreEntry` (`library.entry.restore`) restores the retained snapshot including its original sequence, then stamps a fresh sequence onto the live row.
- `reconcileCollectionBulkStatus` allocates and stamps on a successful bulk state change; same-state `no_effect` returns before allocation.

Archives never compete as live state. Subsequent set and valid Undo use fresh order; neither copies an archive's old sequence into current truth. Derived repair, epoch re-keying and physical payload purge never allocate; originals and source stamps remain untouched. Never infer ordering from timestamps, UUIDs or source-type positions.

Bounded legacy NULL migration, cutover and canonical readiness remain required producers and are unexecuted here. Neither null nor these columns/helper establishes canonical readiness.

Terminal full-graph cleanup erases exact `library.owner_write_counter (route, account_id)` in owned-graph phase `owner_write_counter` after T fences writers, in indexed pages of at most 100 keys, after dependent private facts. Live and archive `owner_write_seq` leave with those payloads. This private counter is neither account lifecycle generation nor a disclosed count or permission witness. Complete terminal and shared-custody erasure remain separate; this phase does not prove them.

## Cost

### Owner sequence allocation

- Touches: one owner counter primary-key initialize/update and the existing same native transaction/account admission.
- Bound: two statements, constant rows plus indexed depth, one owner's counter contention; no entry/history/global scan or cross-home connection. Native partition envelope contention retains its existing bound.
- Growth check: native captures independently grow unrelated counters and retained history at 64, 512 and 4,096 (64 rows per scale unit) while selecting one owner, excluding setup; assert actual allocator rows/statements and different-owner concurrency. This document executes no such runtime proof and establishes no full composed Collection cost.
