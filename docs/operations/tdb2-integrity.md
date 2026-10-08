# TDB2 integrity: the node-table out-of-bounds fault

On 2026-10-08 the shared dev Fuseki (Jena 6.2.0, TDB2) failed every query that
touched the newest transaction's nodes with
`RuntimeIOException: Out of bounds: (limit N) M` from
`TransBinaryDataFile.checkRead`, until the container was restarted. The dev
store held no damage afterwards.

## What happened

A write transaction fails *after* TDB2 has written its commit point to the
journal but before every component has finished committing. Components commit
in a hash order that differs per JVM, so the quad indexes can already name the
transaction's nodes while the node data file's own commit step, which sets its
readable length (`committedLength`), has not run: that length still ends where
the transaction began. Readers on other threads therefore fail
on exactly those nodes. The failed commit never releases the writer lock, so
the next writer queues behind it, and `journal.jrnl` keeps the transaction's
entries. The next open replays them, which completes the commit; nothing in the
files was ever missing.

[tdb2-integrity.test.ts](../../infra/jena/tests/tdb2-integrity.test.ts) pins this
on Jena 6.2.0: a closed component state channel (what an interrupted write
leaves behind) gives the same error text, a blocked next writer, a non-empty
journal, and a clean scan after reopening. Which exception ended the 2026-10-08
commit is not recoverable: Docker rotated the Fuseki log before 12:47 UTC. The
retained evidence fits only this class:

- the limit equals the offset where the last transaction's first node starts;
- every index entry naming nodes past the limit resolved after the restart, to
  nodes that were on disk;
- the restart at 13:15 logged `Journal recovery start`, which an idle stop never
  does, and no write committed between 12:36 and then.

Aborted writes are not the cause. Jena 6.2.0 buffers the Node-to-NodeId cache
per write thread and drops it on abort ([JENA-1746](https://issues.apache.org/jira/browse/JENA-1746),
fixed in 3.13; [JENA-1785](https://issues.apache.org/jira/browse/JENA-1785)).
Aborts, client disconnects, SIGKILL and SIGTERM during sustained command load,
with concurrent readers, left no damage (see the Goal record).

## Recognise and recover

Signs: the error above in the Fuseki log (the dev anomaly watcher alerts on
`Out of bounds`), `Exception in commit`, `Transaction rollback`,
`IOException during 'commit'`, commands that never return, or a non-empty
`journal.jrnl` while the owner is idle.

1. Stop writers (Main, Account, relay). SIGTERM Fuseki and wait for exit; never
   `kill -9`, never remove `tdb.lock`, `owner.lock` or `clean-stop`.
2. Start Fuseki. The log shows `Journal recovery start` and `end`. Text is
   uncertain after a non-clean stop: follow the Lucene procedure in
   [recovery](recovery.md).
3. Scan a copy (below). `damage: 0` means the store is whole; reopen writers.
4. Any damage (pointers beyond the node file, undecodable or aliased nodes, an
   index disagreeing with another) is not repaired in place. Restore the paired
   recovery set per [recovery](recovery.md). The dev store can instead be
   recreated empty and filled again through the APIs (`task ops:bootstrap`).

## Scan

```sh
task ops:tdb2-scan -- <databases/rezics/tdb2>
```

The scan copies the directory (reflink where the filesystem has it), opens the
copy in the Fuseki image's Jena and decodes every tuple of the quad and triple
indexes. It reports tuples per index, tuples absent from the primary index,
pointers beyond the node file, undecodable pointers, and pointers whose node does
not map back to the same id through the node-to-id index. That last check also
finds a value stored differently from how it was hashed: an image without the
`xsd:integer` patch ([toolchain](../development/toolchain.md)) wrapped unsigned
64-bit values negative. The 2026-10-08 dev store holds 12,144 such quads, all
derived `urn:rezics:search:public` order keys; regenerate that projection
(Offline Lucene rebuild in [recovery](recovery.md)) and scan again rather than
restoring. Node-table
entries that no quad references are counted but are not damage. The scan prints
one JSON object and exits 1 on damage.

Copy only from a stopped owner, or an idle one whose `journal.jrnl` is empty and
whose file modification times do not change across the copy. A raw copy of a
busy store is not a snapshot. `--in-place` scans without copying and is for a
copy you already own.

## Fail-stop

A command-module `commit()` that throws aborts and ends on a best-effort
basis, logs the exception class and message, and halts the JVM with status 70.
The dev Fuseki service uses `restart: unless-stopped`, so that exit comes back
and the next open replays the journal. A commit failure outside the command
module still needs the manual restart above.
