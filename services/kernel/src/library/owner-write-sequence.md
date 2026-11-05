# Native owner write sequence prerequisite

[Owner state-write order](../../../../docs/library-and-collections.md#owner-state-write-order) owns behavior. This receipt updates only the module README's missing allocator/column inventory. Current entry/command/DAO/HTTP/restore writers remain unchanged and do not allocate. Helper/schema acceptance proves no profile, dynamic Collection, entry lifecycle, merge, clear or Undo API capability; those proofs remain open.

The exact ABI is `allocateOwnerWriteSeq(tx: CommandTransaction, accountId: string): Promise<bigint>` from `owner-write-sequence.ts`. It requires a live native authorized execute body, that owner's account attribution and actual matching partition. Invalid routes, wrong homes and expired/copied transactions fail before SQL. This trusted helper supplies no permission or connection: commands retain ordinary owner admission/scopes and `shareAccount` before receipt lookup. Callers cannot select a sequence.

Migration `20261028182526_owner_write_sequence.sql` adds private `library.owner_write_counter`, primary key `(route, account_id)`, and nullable private bigint `owner_write_seq` on live `library.entry` and retained `library.entry_deleted`. Present sequences are positive; null means genuinely legacy/unsequenced. There is no default/backfill. Existing constraints, pins, incarnation/archive fields and source hooks are unchanged; no fact copies, membership witnesses or per-state caches are added.

First authorized state mutation inserts the owner's internal zero counter with `ON CONFLICT DO NOTHING`, then executes `UPDATE ... SET seq = seq + 1 ... RETURNING seq` in the same transaction. Only positive bigint escapes, without Number conversion, max scan, reset or wrap. PostgreSQL overflow aborts. Native receipt replay skips the body. A no-op command callback only rejects `noEffect` after allocation; it supplies no ordering. Domain exceptions and failed/CAS/denied/occupied/expired operations must abort the entire fact transaction, rolling back initialization/increment, fact, receipt and outbox. Never catch a failed domain result and commit it. Successful state set allocates even for an equal value; equality is not receipt replay.

Consumers allocate on successful set, physical clear and Undo; Undo gets a new sequence despite exact restored dates/pin. Retain the original snapshot's sequence in the archive; archives never compete as live state. Clear preserves the adopted retained/physical-delete response contract and creates no sequence tombstone. Derived repair, epoch re-keying and physical payload purge never allocate; originals and source stamps remain untouched. Bounded legacy migration/cutover/readiness and writer integration remain explicit missing producers. Neither null nor these columns/helper establishes canonical readiness. Never infer ordering from timestamps, UUIDs or source-type positions.

Terminal full-graph cleanup must erase exact `library.owner_write_counter (route, account_id)` after T fences writers, plus sequences with live/archive private payload. The participant runtime remains absent: erasure is not complete. This private counter is neither account lifecycle generation nor a disclosed count or permission witness.

## Cost

### Owner sequence allocation

- Touches: one owner counter primary-key initialize/update and the existing same native transaction/account admission.
- Bound: two statements, constant rows plus indexed depth, one owner's counter contention; no entry/history/global scan or cross-home connection. Native partition envelope contention retains its existing bound.
- Growth check: native captures independently grow unrelated counters and retained history at 64, 512 and 4,096 (64 rows per scale unit) while selecting one owner, excluding setup; assert actual allocator rows/statements and different-owner concurrency. This establishes neither full composed Collection cost nor the open merge/clear/Undo API proofs.
