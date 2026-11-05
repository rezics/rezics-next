# Public filtered observations: native cut and physical acknowledgement

Evidence date: 2026-10-29. Repository examined: `e9a130649da243117a1df999b47dab976457af2b`.
This is feasibility evidence, not an adopted design, implementation approval or public-capability completion.

## Finding and evidence status

**A complete finite-progress implementation under the adopted bounds is not established.** PostgreSQL can
atomically append a home-local reduction and can distinguish transactions invisible at an earlier snapshot.
OpenSearch can preserve an immutable PIT, report refresh visibility, and block shard operations during native
index-block verification. None of those primitives alone supplies the missing combination: commit-visible,
key-scoped, home-coalesced observation with bounded maintenance, immutable observation coverage, and durable
custody of every old writer through physical deletion. The counterexamples below reject specific constructions;
they do not prove that every possible native representation is impossible.

**Proven by inspection:** configured versions, existing SQL/indexes, protocol requirements, native snapshot
representation, external-version conflict/pruning logic and native index-block verification. **Proposed:** the
illustrative metadata layouts and schedules below. **Experimented here:** none; no server was started or queried,
and no upstream code was installed, built or executed. No native row, block, byte, latency or served-share capture
is claimed. The existing late-write test is a source-level counterexample specification, not a passing run here.

## Requirements and actual boundary

The complete [Filtered lists](../filtered-lists.md), especially Current disclosure and Cost, remains authoritative.
The inspected [Source specification](../../services/kernel/src/semantic/public-filter-source-contract.md) and
[types](../../services/kernel/src/semantic/public-filter-source-contract.ts) are specification-only.
The [Search contract](../../services/kernel/src/search/public-filter-consumer-contract.md) and
[canonical type](../../services/kernel/src/search/public-filter-consumer-contract.ts) are unchanged from
`5a91978a7c`; both producer modules are missing. The later `ea7fab3b35` Source change was inspected only as
superseded context: its live branch, requirements/key arrays and returned-subject request fields are not inputs
to the agreed population protocol. No new method, resolver, factory or executable ABI is selected here.

Population observation must resolve the ONE `PublicFilterQueriedObservation` plus native execution locator for
final observation, retained start and context. Native state supplies the immutable definition, FULL key closure
and actual returned original/terminal pairs. The old Source population type currently carries consumer/start
only: the joined narrowed runtime input is still missing. Neither that type nor its diagnostic acknowledgement
needs object establishes executable joining, actual ACK storage or authority.

Capture retains the expanded `FilterDocument`, `TextNode`, accepted release/type, actual Source identity and
configuration, order, size, typed keyset and derived plan. Required filter/text fields permit explicit undefined;
compiled-only input is invalid. Saved expansion uses existing admission; OwnerLeaf anywhere under NOT/OR/saved
expansion rejects before native I/O. Compiler compatibility fields cannot override the shared AST. Closure covers
all positive/negative/disjunctive branches, same-statement qualifiers/units, text labels/aliases/descriptions,
implicit type, name/id ties and admitted rating/Collection functional-order inputs. Matched queries and returned
IDs cannot determine that closure. See also [TextNode](../../services/kernel/src/search/text.ts) and
[SearchPlan](../../services/kernel/src/search/query.ts).

The observation is exactly PIT OR immutable prepared build/generation. Resolve physical index UUID/incarnation,
consumer/projection generations, accepted meaning/read definition and actual source binding from registration.
Copying a locator, mutating caller AST/keyset, renewing against another PIT, same-name recreation, closed/expired
state or an unknown source cannot prove safety. The reader-only Source port cannot establish its native identity
or registered read definition; this is an explicit prerequisite, not an inference from function identity.

Privacy reductions append in the SAME domain transaction and authoritative home, using dedicated monotonic
bigint privacy positions. Ordinary `core.partition.position`, identity epoch, relay progress and timestamps remain
distinct. Relevant changes on excluded subjects protect NOT and order even with zero candidates. Subject-wide
reductions affect every key; actual returned originals AND terminals additionally need ALL-key checks. Foreign
target/qualifier/consent/tuple/Collection causes route to affected SOURCE keys, including selected currently
ineligible inputs. Unknown routing and late registration block; restoration must remain discoverable.

Decision17 observation instrumentation required by this assignment is exact: role SQL begins
`/* semantic.privacy-start */` or `/* semantic.privacy-final */`; separate keyed own-row work begins
`/* semantic.own-rows */`. Merging own-row work into final counts its FULL coverage work. The inspected tracked
Filtered lists text states the numerical coverage rule but does not contain those tag literals; this report
records the supplied instrumentation requirement without claiming existing SQL implements it.

| Existing native evidence                                                                                                     | What it supplies; what is missing                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [command/fence.sql](../../services/kernel/src/command/fence.sql), [command.ts](../../services/kernel/src/command/command.ts) | Home position, outbox/receipt atomicity, serializable command attempts and authorization before receipt; no privacy append/cut. Receipt replay avoids the command body; genuine noEffect must not append.          |
| [semantic/search-source.ts](../../services/kernel/src/semantic/search-source.ts): `subjectSource`                            | Repeatable-read source snapshot, at most 256 requested IDs per native call; current fact/history folding and missing-position zero fallback are not complete bounded public projection/coverage.                   |
| [semantic schema](../../services/kernel/db/semantic/schema.sql)                                                              | Subject PK `(route, subject_id)`, candidate/selection/link/provenance indexes; no authoritative privacy head/log, complete current selected-facet stream or public observation registration.                       |
| [search schema](../../services/kernel/db/search/schema.sql)                                                                  | Physical-incarnation and ordinary coverage metadata already exist; their `subject-coverage-v1` JSON coverage ABI does not implement the adopted privacy protocol and must not be revived for it.                   |
| [core schema](../../services/kernel/db/schema.sql)                                                                           | Checkpoint PK `(partition_no, consumer)`, outbox PK `(partition_no, position, event_seq)`; ordinary checkpoint settlement is not physical privacy ACK.                                                             |
| [indexer.ts](../../services/kernel/src/search/indexer.ts)                                                                    | Real `aroundApply` admission seam surrounds the actual source-read/write operation exactly once; default runner does not install a privacy guard.                                                                  |
| [write-actions.ts](../../services/kernel/src/search/write-actions.ts)                                                        | Bulk external writes with `refresh=wait_for`; version conflicts trigger a validated explicit refresh. It does not establish that a conflicting winner contains the required foreign repair or fence future writes. |
| [runner.ts](../../services/kernel/src/search/runner.ts), [events/relays.ts](../../services/kernel/src/events/relays.ts)      | Local pause/stop drains tracked relay promises, including current generation replacement; no durable cross-process writer inventory, per-observation registry or engine request cancellation/drain proof.          |

The active research registry's scope listing was checked without reading the independent report. Private Library
observation and Accounts shared-history locator work are different owner scopes; neither is re-derived here.

## Native versions and primary sources

The repository pins PostgreSQL **19rc1**, image digest `7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108`
in [database.ts](../../services/kernel/scripts/database.ts), and OpenSearch **3.9.0**, digest
`adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c` in its
[Dockerfile](../../services/kernel/db/search/opensearch/Dockerfile). These are configured pins, not observed servers.

Reference root below is `/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were reused; only
the PostgreSQL release tag was fetched, without changing either clone's checkout. Entries are recorded in INDEX.md.

- **P:** `library-shelf-maintenance/postgres`, tag `REL_19_RC1`, commit
  `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`, PostgreSQL License (`COPYRIGHT`). Its existing HEAD is 20devel and
  was deliberately not used as version-19 implementation evidence. [Release source](https://github.com/postgres/postgres/tree/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89).
- **O:** `search-rating-populations/opensearch`, commit `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, 3.9.0,
  Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`). [Pinned source](https://github.com/opensearch-project/OpenSearch/tree/4ee42a94e87f66fbf1e62a9871b1b87f91e02472).
- **D:** `search-rating-populations/documentation-website`, commit `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`,
  Apache-2.0 (`LICENSE`, `NOTICE`). This documentation checkout is supporting explanation, not proof of the
  installed implementation. Version-specific rendered OpenSearch 3.9 URLs were unavailable through the browser;
  conclusions use O's pinned implementation and D's exact files instead of silently substituting latest behavior.

## Candidate metadata and indexed access

The following names are illustrative SQL relations inside the adopted log/registration concepts, NOT migrations,
new stores or exports. A minimal atomic home representation has a head PK `(home)`, append history PK
`(home, privacy_position)`, ownership epoch and command/operation deduplication. Store affected native locators
and source-key impacts, not values or permissions. A row lock held to transaction end serializes that home's
increments. Every domain rollback also rolls back head, log and maintenance; receipt replay cannot append again.
History paging is an exclusive key seek through a fixed inclusive head, charging rejects/lookahead and gaps.

For a hypothetical current-head change index, add the writer's explicit **top-level** `xid8`:

```sql
-- Proposed columns: home integer, epoch integer, position bigint, writer xid8.
CREATE UNIQUE INDEX h_pk ON h(home);
CREATE INDEX h_writer ON h(writer, home) INCLUDE (epoch, position);
-- Append transaction: lock home, increment head, append cause/impacts and writer;
-- all occur on the command's existing transaction, before receipt/outbox commit.
```

Do not use tuple `xmin`: it is a 32-bit system field, may represent subtransactions and changes with maintenance;
it is not the retained top-level `xid8` identity needed here. The 24 bytes of logical head scalar payload above
exclude heap/index headers, alignment, tuple versions, WAL and wire encoding; they are not a measured storage cost.

An efficient behind index cannot have `WHERE h.position > ack.position`: PostgreSQL partial-index predicates
refer to their own table and cannot contain subqueries. Index functions must be immutable, excluding lookup of
mutable ACK state. See P `doc/src/sgml/ref/create_index.sgml:81–95` and
[CREATE INDEX](https://www.postgresql.org/docs/19/sql-createindex.html).

For ONE registered consumer, co-locating head/ACK in a registration-owned home summary permits:

```sql
-- Proposed only: r is one registration's home-summary metadata.
CREATE INDEX r_behind ON r(registration, home)
  WHERE head_position > ack_position;
/* semantic.privacy-start */ SELECT home, epoch, head_position FROM r
  WHERE registration = $1 AND head_position > ack_position;
```

This fragment omits cut retention, binding, routing and ownership validation, so is NOT a complete observation
statement. Both reduction and ACK must lock/CAS the SAME summary state. An ACK for p must not clear head p+1:
update acknowledged-through p and let the inequality remain true. CAS includes incarnation, generations, meaning,
definition, ownership epoch, registration/routing revision and expected prior ACK. Contiguity requires retained
receipt/frontier evidence for every earlier entry, not `max(completed_position)`.

The maintenance hole is explicit: reflecting a new head into summaries for N consumers costs N updates per
reduction. Adding per-definition relevance summaries costs the number of matching registrations/definitions,
which can grow without an adopted bound. Existing quotas of 32 owner results and one current/one building public
generation do NOT bound all public definitions, consumers, PITs or executions. Asynchronous fanout leaves a
commit-visible gap unless a separately visible unresolved barrier blocks affected reads until completion.
Making that barrier global makes unrelated reductions suppress service; it cannot satisfy the final scale gate.

Key-leading `(source_key, home, position)` impact indexes avoid unrelated log history, but OR-ing keys can return
many rows per home. `DISTINCT`, hash aggregation, bitmap construction, GIN postings/rechecks and lateral LIMITs
must charge their input/index work. A single changed home with 4096 reductions still permits only 66 coverage
rows when no home is behind. Reading those 4096 entries to classify relevance is already a counterexample.
Keeping only the latest impact misses an earlier relevant reduction followed by an irrelevant one. Keeping a
union since the oldest observation introduces retained-history/metadata growth. Coalescing one row per
definition/home can solve that read shape only if its update/registration cost and retention are also proved.

## Commit-visible cut: correctness versus indexed cost

P `src/backend/utils/adt/xid8funcs.c:188–218,371–411` implements snapshot visibility using xmin/xmax and sorted
in-progress top-level transaction IDs. [Version-19 functions](https://www.postgresql.org/docs/19/functions-info.html)
describe `pg_current_snapshot`, `pg_snapshot_xip` and `pg_visible_in_snapshot`, including the subtransaction warning.
Within ONE PostgreSQL database, retain start snapshot S and examine a FRESH final statement snapshot F. For a
head row visible in F, a writer not visible in S identifies a head change since S, including a lower allocated
transaction that committed late. Keeping the start repeatable-read snapshot for final instead would miss changes;
[transaction isolation](https://www.postgresql.org/docs/19/transaction-iso.html) explains that fixed visibility.

For the latest committed head per home, the exact split is:

```sql
-- Illustrative final lookup; S must resolve from retained native start, not caller JSON.
/* semantic.privacy-final */
SELECT home, epoch, position FROM h WHERE writer >= pg_snapshot_xmax($1::pg_snapshot)
UNION ALL
SELECT h.home, h.epoch, h.position
FROM pg_snapshot_xip($1::pg_snapshot) AS x(writer)
JOIN h USING (writer);
```

The ranges are disjoint. The final MVCC snapshot removes still-uncommitted/aborted writers. A later home writer
cannot erase the change: if it was invisible at S, it too lies in one branch. Writers sharing a transaction across
multiple reductions in their home still advance monotonically. ACK must not overwrite `writer`; otherwise an
ordinary ACK write corrupts the change evidence. Restore/ordinary writes must not erase privacy evidence either.
Snapshot visibility does not assert that an aborted transaction committed; this reasoning applies only to rows
actually visible in F. Home-local locks do not make writer XIDs numerically monotonic across transactions.

**Correct visibility is not a budget proof.** Let A be S's in-progress top-level XID count. P's structure stores
`24 + 8A` bytes before external encoding, and `pg_current_snapshot` copies/sorts that array. The second branch
enumerates A rows and performs up to A index probes, even if every transaction is ordinary unrelated work and
behind=changed=0. Choosing A=4096 breaks the 64-row coverage allowance without one relevant reduction.
Retaining S server-side saves transport, not metadata traversal, storage or index work. Native proc-array work
also needs accounting. A `writer >= xmin(S)` scan instead visits arbitrarily many already-committed heads behind
one long-running old transaction; applying `pg_visible_in_snapshot` as a filter does not make it an index bound.
No snapshot-dependent partial index supplies this predicate. This candidate needs a bounded privacy-specific
commit-visible access primitive; an opaque snapshot token alone is insufficient.

Additional tempting substitutions fail independently:

| Construction                                          | Falsifiable counterexample or boundary                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Precommit sequence, UUID or wall-time high-water mark | T1 allocates 10 and waits; T2 allocates 11 and commits; start retains 11; T1 commits during query. Final `position > 11` misses T1. Per-home position is safe locally, not a global commit order.                                                                                                                                                                                                                                          |
| Current dirty bit / live ACK                          | Query starts on old PIT; reduction commits, physical repair completes and ACK clears dirty; final sees clean and leaks stale exclusion/order. Changed-since-start evidence must survive ACK.                                                                                                                                                                                                                                               |
| Exported repeatable-read snapshot                     | Retaining its exporter holds a transaction/connection and vacuum horizon; final on the same snapshot cannot see intervening commits. A serialized snapshot value is different and has the A-dependent cost above. See [snapshot synchronization](https://www.postgresql.org/docs/19/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION).                                                                                              |
| Commit timestamps / current WAL location              | Wall-clock order is not a visibility proof; a WAL location read or row's precommit WAL position is not its committed transaction's visibility frontier. No SQL trigger here publishes the future commit record atomically into an indexed row.                                                                                                                                                                                             |
| Logical decoding / commit LSN                         | Native decoding can expose committed transactions and replay after crash, but a committed reduction can precede decoder publication. Waiting for decoder catch-up needs a proven current barrier and charged WAL/metadata work, not a lag allowance. Slots retain resources and can replay duplicates; see [logical decoding](https://www.postgresql.org/docs/19/logicaldecoding-explanation.html), P `doc/src/sgml/logicaldecoding.sgml`. |
| Serialized global transactional counter               | A common row lock held through every reduction commit gives a valid scalar visibility order in one database. It adds cross-home shared writes/serialization to single-partition commands and still needs scoped/coalesced indexes without unbounded registration fanout. It is an owner architecture choice, not an accepted free counter.                                                                                                 |
| Cached all-home registry / multi-database snapshots   | Explicit coverage/ownership changes must invalidate observations atomically. PostgreSQL snapshots apply to one database; there is no demonstrated two-statement cross-owner cut/availability composition. Missing/moved owners cannot become zero.                                                                                                                                                                                         |

## Immutable coverage and physical ACK schedules

O `server/src/main/java/org/opensearch/action/search/SearchContextId.java:64–109` binds contexts to native shard
identities; it does not bind this application's Source, AST or ACK. D `_search-plugins/searching-data/point-in-time.md`
explains retained segments and frozen results: [pinned PIT documentation](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_search-plugins/searching-data/point-in-time.md).
Repairing a live index does not repair an old PIT or immutable prepared generation. Their native registration must
retain what THAT observation covered. Even a NEW execution started after repair must reject an older unsafe
observation when relevant reductions fall between its covered cut and execution start; changed-since-start alone
does not cover this case. Coverage cannot be stamped from a snapshot taken after refresh if a reduction committed
between that refresh and the stamp. Capture/repair must retain a justified earlier covered cut and validate it.

| Schedule                            | Required result and missing prerequisite                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlapping home writes             | T1 locks/increments h to p; T2 waits; T1 aborts, then T2 commits. Domain/head/log all roll back for T1; only T2's committed entry exists. Same-home serialization must survive serializable retry and receipt replay.                                                                                                |
| Reduce then ACK between start/final | Retain immutable O and S; run actual query; commit relevant reduction p; repair all local/foreign effects, refresh and ACK p; final must find changed p even with pending empty. O never borrows live ACK. Repeat relevant NOT/name-order with zero returned rows and unrelated excluded-key changes that may serve. |
| ACK CAS races p+1                   | Repair p observes routing revision r; new reduction advances head or registration changes r; ACK CAS loses or acknowledges only p. It cannot clear newer dirty state or assume the winner's effects. Persisted winner and refresh receipts must be checked.                                                          |
| Late foreign registration           | Register a dependency after foreign p is ACKed. It either joins a retained repair frontier or remains unpublished until it checks/rebuilds against p. Selected currently-ineligible inputs need registration too; visible-only maps fail on restoration.                                                             |
| Source version unchanged            | A foreign reduction at position 100 changes a source whose old anchored external version is 7. Sending corrected body at 7 gets 409 against stale body 7; refreshing that winner leaves it wrong. Actual dependent source-own anchored advancement is required before repair can ACK.                                |
| Crash / ambiguous bulk response     | Sink may have applied although transport failed. A new attempt resolves actual winning body/version, shard success and refresh; no success Boolean or dispatch receipt advances ACK. A lost old attempt remains a physical writer-custody obligation.                                                                |
| Identity/source restoration         | Privacy counter/history never resets on restore, unmerge, source eligibility recovery or ownership movement. Retain rejected dependency locators, repair under the current source-own version, and separately gate pending identity epoch.                                                                           |

**Concrete physical counterexample:** W reads eligible version v and its request is delayed before engine receipt.
A reduction writes delete v+1; refresh succeeds; database CAS advances ACK. After `gc_deletes` pruning, W's old
external-v index request reaches the primary and recreates the document. O `index/VersionType.java:111–126`
accepts an external version when current version is NOT_FOUND; O `index/engine/InternalEngine.java:1343–1349,
1523–1526,1753–1778` prunes delete versions by age and processed checkpoint. Native sequence-number replica
ordering does not reject an old client request newly assigned a sequence number by the primary.
The repository's [late-write-pruning.test.ts](../../services/kernel/test/search/late-write-pruning.test.ts)
specifies native 409-to-201 pruning plus hide/takedown and checkpoint-loss races. A finite larger retention time
cannot defeat an arbitrarily delayed request. Permanent soft tombstones and database-CAS-only ACK are excluded.

There IS an additional native drain primitive worth distinguishing from the local runner: O
`rest/action/admin/indices/RestAddIndexBlockAction.java` exposes `PUT /{index}/_block/{block}`; O
`action/admin/indices/readonly/TransportVerifyShardIndexBlockAction.java:104–170` acquires all primary/replica
operation permits and checks the applied block. `cluster/metadata/MetadataIndexStateService.java:1052–1124`
checks verification/finalization races. A successfully verified write block can drain admitted shard operations
while the block remains installed. This is stronger evidence than a local promise set or a settings request alone.
It does not identify delayed clients, revoke their bytes, clean retained PIT segments, or keep their old writes
rejected after unblocking. Counterexample: delay W before dispatch, verify block, unblock for repair, then dispatch
W after delete pruning. Keeping a shared index blocked forever fails finite progress; rolling physical retirement
would require separate owner-reviewed writer/retained-copy custody and bounded transition work. No such design is
selected or deployed here. Cross-process crash recovery and all writer entry points remain unknown custody.

## Cold population, retention and all-role erasure

Cold projection starts from each KNOWN subject. [page.ts](../../services/kernel/src/semantic/page.ts) and
[page-subjects.sql](../../services/kernel/src/semantic/page-subjects.sql) provide a real `(route, subject_id)` PK
seek with epoch and size+1 lookahead, but the SQL also hydrates latest labels using historical fact aggregation.
That hydration is neither public truth nor a cheap raw-key primitive. An internal bounded keys-only traversal can
reuse the existing PK and retained work frontier without copying the Search matcher or inventing a public API.
Count every known key, hidden/rejected key and lookahead; consume only examined keys, with at most 1000 inputs.

Concurrent creation can insert UUIDs behind a key frontier. Therefore native registration must connect a
population frontier to lossless creation/change catch-up: pre-frontier items are visited, later creations are
covered by the retained command log regardless of key order, and publication checks the finite handover window.
Existing ordinary outbox may carry catch-up work but is not the privacy cut. Required-log retention must be pinned
to the build's window; a gap/epoch change yields explicit rebuild/preparation, never false exhaustion. Repeatedly
rescanning after each retention gap gives no finite-progress proof. Bounded retention/catch-up ownership is still
missing. No null-consumer clean mode or permanent preparing is acceptable on quiescent finite healthy input.

[Deletion](../deletion.md#account-erasure) requires every account role and exact shared-copy locators. The actual
[agents.ts](../../services/kernel/src/semantic/agents.ts): `accountAgentId` identifies a stable agent and
`accountAgentsForSubjects` does bounded native mapping; neither enumerates every author/editor/operator/delegate
role or every affected public subject. Erasure must cover public agent metadata in all live generations, retained
PIT/prepared copies and delayed writers, plus Semantic editorial/provenance/Zone sources and exact copy locators.
Accounts owns shared-history minimization, Content owns delivery custody; this report does not duplicate those
designs. Every-role affected-subject/dependency enumeration and minimized-source completion ports are missing.
An incremented account/version counter cannot attest physical cleanup. Unknown custody cannot be reported as
none/erased; no name/account-wide JSON scan, ownership graph, grant certificate or separate engine is proposed.

## Exact ceilings and hidden scaling terms

Let Hᵦ/H𝚌 denote counted behind/changed homes, c actual candidates including rejects/duplicates/lookahead,
K full derived input keys, N registrations/definitions, A active XIDs, L required impact history, and W unresolved
writers. All counts include internal SQL, metadata, removed rows and failed/replayed work; a function wrapper
does not make its nested work one free row/statement. Capture, query and readStatus share inclusive page accounting.

| Work                                         | Adopted ceiling / obligation                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All-home start + final, shared once per PAGE | At most 2 statements and `64 + 2*(Hᵦ + H𝚌)` examined rows; no 8192 head-vector rows, full scans or hidden aggregation. Separate own-row keyed work remains inside whole-page limits.                 |
| Direct read                                  | c ≤ `min(600,6s+3)`; 6 engine searches; 3 owner seeks; points ≤ `16+8c`; PG rows ≤ `64+16c`; blocks ≤ six per budgeted row; response ≤ `16 KiB+4 KiB*c`; request ≤ `64 KiB+1 KiB*c`.                 |
| Ready-result read                            | c ≤ `2s+2`, at most 2 index reads; other point/row/block/byte ceilings use actual c.                                                                                                                 |
| Statements/connections/output                | One-read page ≤12 statements/backend; composed ≤`8+4R`, R≤16, total slots≤128; one connection/backend, released before another owner or engine I/O.                                                  |
| Max composed direct page                     | 816 candidates, 6784 points, 14080 PG rows, 72 statements/backend, 96 engine searches. Fixed privacy/epoch/summary work is shared, never multiplied into an exemption.                               |
| Repair/preparation step                      | ≤1000 inputs, 1000 result writes, 1 retained-frontier write, 16 statements/backend, 4 searches, `64+16*input` rows, 8 points/input, six blocks/budgeted row, 4 MiB response, one connection/backend. |
| Total preparation                            | Linear relevant finite input; replay rereads at most one step. Owner results≤32/owner, idle expiry 24h; public one current/one building generation per definition. No new quota/allowance inferred.  |

For the proposed layout, an emitted `(home integer, epoch integer, position bigint)` head has 16 logical scalar
bytes: `16*(emitted behind heads + emitted changed heads)`; h additionally stores its 8-byte writer. Snapshot
retention costs `24+8A` bytes per retained S, plus tuple/index/WAL costs. These are logical payload equations,
not wire captures or allocations. Definition/AST/keysets, locator identifiers, impact arrays, routing
and execution own-row sets add their actual bytes. No separate free control-byte allowance exists; Performance
must place them inside the existing page budget using native capture. No numeric pass can currently be supplied.

Hidden terms preventing a completion proof are: A snapshot enumeration/probes; K×home impact multiplicity; L
history classification; N synchronous summary updates per reduction or an unresolved asynchronous publication
gap; active-cut/history retention; W durable writer reconciliation; owner/availability checkouts; source-selection
history hydration; and late-registration/restoration fanout. Deduplicated output cannot erase any of these costs.

## Falsifiable next evidence and smallest owner decisions

Use only disposable owned fixtures/probe files under `.temp`, never production data. A controlled native experiment
must record `SELECT version()`, engine root version and physical `_settings` UUID before interpreting behavior.
No probe below has been run here; no absent tool/server is being represented as successful evidence.

1. On 19rc1, retain S, hold a lower-XID home reduction uncommitted, commit a higher-XID reduction elsewhere, then
   commit the held writer between engine execution and fresh final read. Compare scalar-watermark failure with
   snapshot membership. Add A unrelated open transactions and capture both branches using EXPLAIN ANALYZE/BUFFERS
   plus nested statements, native rows/index work and actual wire bytes. Repeat zero/small H and L=4096 in one home.
2. On 3.9.0, retain a real PIT and immutable prepared observation; gate actual query, reduction, local/foreign
   repair and native refresh completion; advance genuine ACK before final. Assert pending empty yet old observation
   blocked, including new execution on the old observation, relevant NOT/order zero hits, own-row unrelated-key
   reductions, irrelevant excluded-key service, caller mutation, UUID recreation and expired/missing locators.
3. Gate old writes before send and after native effect; exercise crash/lost response, ACK CAS loss, late dependency
   registration, dependent own-version advance and source restoration. Observe actual pruning, then release W.
   Verify write-block drain separately while installed AND after unblock. Do not infer remote cancellation from
   fetch timeout. Existing transport controls/aroundApply are seams, not successful custody evidence.
4. At 64/512/4096 vary relevant population, matches, sparsity, history, owner pools, aliases to4096 and depth;
   include 16 reads/128 slots and reduction rate rising with population at actual repair/ACK latency. Measure all
   page and maintenance units plus served share. Unrelated reductions must not lower it: global blocking has
   approximately `exp(-arrival_rate*ACK_latency)` served share and fails as rate grows. Under quiescence, finite
   admitted work must reach a useful complete page after replay without restarting settled input.

The sources share a useful pattern: native MVCC, PIT, versioning, refresh and block acknowledgements each prove
one precisely scoped event. Application registration, routing and retained execution must join those events;
none of their native tokens is a permission grant or a complete physical cleanup receipt.

The smallest next Semantic/Search/Performance decision is the **actual log/registration access and concurrency
invariant**: how a committed reduction is immediately discoverable as a relevant, home-coalesced change without
A/L scans or unbounded N fanout, while all-home ownership coverage and retained cuts remain valid. In parallel,
Search must establish complete durable writer/retained-copy custody using existing engine/work/receipt concepts;
Semantic must supply native Source/read-definition binding and anchored dependent refresh. Accounts/Content and
Semantic must close their every-role affected-source/minimization dependencies before erasure readiness.
These are explicit missing primitives/owner boundaries, not authorization to loosen policy, increase a bound,
select a new engine, implement a stand-alone runtime fence or launch from this report alone.
