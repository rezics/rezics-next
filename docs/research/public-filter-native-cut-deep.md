# Native public-filter cuts and physical acknowledgement

Research evidence, 2026-10-29. No runtime, schema, API, engine or policy change is adopted here.

## Finding and evidence status

**A complete feasibility and finite-progress proof is still missing.** PostgreSQL supplies transactionally
visible home state and useful indexed subpaths; OpenSearch supplies immutable PITs and refresh-visible writes.
Neither automatically supplies the required scoped all-home cut, atomic registration or custody of every old
writer. The counterexamples below rule out specific shortcuts, not every possible native implementation.
The smallest unresolved boundary combines indexed change discovery, registration coverage and writer custody;
implementing only a counter or an ACK CAS cannot close it.

**Proven from inspected source/contracts:** MVCC visibility rules, the snapshot representation, partial-index
restrictions, current relay/source seams and external-version deletion behavior. **Proposed:** all SQL below,
summary layouts and controlled schedules. **Experimented:** no database/engine experiment was run, and no
benchmark or budget pass is claimed. **Unknown:** production plans, physical captures, complete native routing,
registration/cut lifecycle, distributed writer custody and useful served share.

The repository pins PostgreSQL **19rc1**, image digest `7c70c245…a69108`, in
`services/kernel/scripts/database.ts:9`; OpenSearch **3.9.0**, digest `adfa61f8…6c7c`, in
`services/kernel/db/search/opensearch/Dockerfile:1`. These are configured versions, not observations of a running
server. Local `postgres`, `psql` and `initdb --version` report **18.6**; they were not substituted for 19rc1.
The reused PostgreSQL clone's default branch is 20devel; evidence instead uses its exact `REL_19_RC1` tag,
commit `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`.[P1] OpenSearch evidence is the pinned 3.9.0 commit.[O1]
Versioned OpenSearch web documentation could not be retrieved through the browsing tool; pinned upstream code
and the retained official documentation source were readable. This limits web-version verification, not source access.

## Requirements and actual gaps

The complete [Filtered lists](../filtered-lists.md), particularly privacy, preparation and Cost, is authoritative.
The current [Source specification](../../services/kernel/src/semantic/public-filter-source-contract.md) and its
[types](../../services/kernel/src/semantic/public-filter-source-contract.ts) are specification only. The
[Search consumer specification](../../services/kernel/src/search/public-filter-consumer-contract.md) and
[canonical types](../../services/kernel/src/search/public-filter-consumer-contract.ts) match inspected commit
`5a91978a7c`; no sibling feasibility report was read. The preserved `ea7fab3b35` Source proposal was inspected
only as superseded context: its live branch, requirements, caller keys and returned-subject inputs are not adopted.
The assigned registry check distinguishes this question from Library private observations and Accounts shared history.

- A reduction and its bounded cause/key impacts commit in the **same native domain transaction and actual home**.
  Dedicated monotonic bigint privacy positions differ from ordinary catalogue progress; rollback/replay/noEffect
  cannot invent a reduction. Subject-wide causes affect every key; foreign causes route to source keys, including
  selected currently ineligible inputs. Unknown routing or late registration blocks publication.
- Scope is the entire expanded immutable FilterDocument, TextNode, NOT/OR/saved branches, qualifiers/units,
  implicit type/name/id/ties and functional-order inputs. Every returned original **and** terminal additionally
  checks ALL its keys. A zero-result NOT/order query still requires population coverage.
  Capture uses accepted-release `admitFilter`, `compileFilter` and `compileText`; rejects OwnerLeaf anywhere
  before native I/O and rejects compiled-only/mismatching compatibility DSL. Explicit undefined means absent
  filter/text. Retain boosts, overflow semantics, order/size/keyset and factory meaning against caller mutation.
- The population input to close is only canonical `PublicFilterQueriedObservation`, native execution locator
  for final, and retained start/context. Native state must resolve FULL keys, original/terminal rows and the
  actual Source object/configuration plus immutable definition. No operation/factory/resolver is selected here.
- Bind native index UUID/incarnation, physical name, consumer/projection generations, accepted meaning and read
  definition. The canonical snapshot has ONE PIT or immutable prepared branch. Copies, mutation, expiry, unknown
  locators or a newer live ACK cannot prove an older observation safe. Current authority remains independent.
- Shared logical coverage spans all 4,096 homes, including failures/moves, in at most two statements and
  `64 + 2*(B+D)` examined rows, where B counts behind homes and D changed homes. Metadata, removed rows and
  capture are charged. Required attribution prefixes are exactly `/* semantic.privacy-start */` and
  `/* semantic.privacy-final */`; separate keyed own-row work uses `/* semantic.own-rows */` inside the page budget.
  A merged own-row final must still account for full population coverage. These prefixes must start role SQL.
- A reduction committed after execution start remains detectable after repair and ACK before final. ACK covers
  a contiguous prefix only after LOCAL and all FOREIGN effects are refresh-visible and dependent own-source
  versions genuinely advance. No old native write may become visible after ACK, including after delete GC.

| Inspected current path | Real capability; missing obligation |
| --- | --- |
| `command/command.ts`, `command/fence.sql`, `db/schema.sql` | Authorized serializable command, receipt/outbox and one-home `core.partition.position` fence. No privacy log, global commit cut or scoped behind index. |
| `semantic/search-source.ts`, `search-source-position.sql` | Repeatable-read bounded-ID snapshots, actual partition position; sampled relations/history folding do not provide complete bounded public projection. |
| Source contract/types | Exactly three future readers; producer module and same-transaction appends are absent. Current population request is consumer/start only, not the agreed executable narrowed join. |
| Search contract/types | Closed full-AST/text/order/size/keyset capture and exact observation/execution semantics; factory, native definition resolution, repair/ACK and default composition are absent. |
| `db/search/schema.sql`, `search/coverage.ts`, `coverage-projection.ts` | Existing incarnation/coverage scaffolding and explicit unready stubs use the older structural protocol. They are not privacy ACK/cut evidence or an ABI to revive. |
| `search/indexer.ts:24-111` | `aroundApply` is a real optional guard wrapping the actual source-read/apply once. Default `search/runner.ts` does not install it. |
| `events/log.ts:projectBatch`, `compare-advance-checkpoint.sql` | Release DB before external apply; afterward CAS ordinary checkpoint. Losing CAS cannot undo a physical write. |
| `search/write-actions.ts:91-112` | Real bulk `refresh=wait_for`, per-item validation and explicit all-shard refresh on accepted version conflicts; no complete privacy repair/winner/custody proof. |
| `events/relays.ts:84-99`, `search/runner.ts`, `work/registry.ts` | Pause/stop drain this runner's tracked promises; DBOS shutdown drains its own work. No all-process/per-consumer old-writer registry or immutable execution observation API. |

Paths in this inventory are relative to `services/kernel/`, with source paths under `src/`.
The existing public-filter producer/consumer tests and late-write scenarios are required future evidence; their
presence is not an executed native pass. This research neither changes frozen acceptance nor supplies product code.

## Small native representations and what they actually establish

The following are **hypothetical metadata of the adopted log/registration**, not delivered tables, exports or
a separate store. An implementation would retain the existing receipts, durable work, OpenSearch and owner ports.

### A. Home heads, a maintained behind index and transaction snapshots

```sql
-- Sketch only: home-leading native log, current row, exact registration identity.
CREATE TABLE privacy_head (
  home integer PRIMARY KEY, epoch integer NOT NULL, pos bigint NOT NULL,
  last_writer xid8 NOT NULL
);
CREATE INDEX privacy_head_writer ON privacy_head(last_writer, home);
-- privacy_log PRIMARY KEY(home, pos), bounded cause/impacts and top-level xid8.
-- registered_home PRIMARY KEY(registration, home), epoch/head/ack/routing revision.
CREATE INDEX registered_home_behind ON registered_home(registration, home)
  WHERE behind;
```

The reduction locks/increments its home head and appends log/impacts in the same existing command transaction;
`pg_current_xact_id()` identifies the top-level writer. Successful receipt replay bypasses the command body.
This establishes home order, not commit order between homes. A partial index over the same row's maintained
`behind` is native; a partial index whose predicate queries another table's ACK is forbidden.[P2]

A retained `pg_snapshot` S is a genuine visibility cut **in one database**. At a fresh final statement, a visible
head's latest writer committed since S exactly when `NOT pg_visible_in_snapshot(last_writer,S)` holds, provided
every reduction updates that row, ownership is stable and final does not reuse S's repeatable-read transaction.
Why: if any post-S reduction committed, the final latest reduction cannot have committed before it and also
before S. Its writer is either in S's active-XID set or at/above S.xmax. Conversely, a writer visible in S did
not first commit after S. XID numeric order need not equal commit order.[P3]

This permits a concrete indexed candidate for **changed-home discovery**, not full narrowing:

```sql
/* semantic.privacy-final */
SELECT home, epoch, pos FROM privacy_head
WHERE last_writer >= pg_snapshot_xmax(:retained_snapshot)
UNION ALL
SELECT h.home, h.epoch, h.pos
FROM pg_snapshot_xip(:retained_snapshot) AS active(x)
JOIN privacy_head h ON h.last_writer = active.x;
```

The disjoint XID ranges avoid duplicate homes. PostgreSQL has native `xid8_ops` B-tree support.[P4]
Correctness includes a lower-XID writer committing late and multiple overlapping writers to one home: record the
latest writer, not `max(xid)`. Arbitrary uncommitted/aborted index tuples remain subject to native MVCC checks.
No persistent transaction or exported-snapshot keeper is needed merely to retain this visibility description;
source history/registration retention and epoch validity are separate obligations.

**Unclosed cost:** with A active XIDs, the shown SRF produces A metadata rows and A equality probes even if D=0.
`pg_current_snapshot` also copies/sorts those XIDs; its internal size is `24+8A` bytes on the inspected layout,
not constant hidden evidence. `GetSnapshotData` can traverse the process array.[P3] Using an array instead of
the SRF changes row accounting but leaves A probes/blocks/bytes; no adopted concurrency bound proves they fit.
The alternative `last_writer >= xmin` plus visibility filter can examine all 4,096 heads while D=0: retain one
old unrelated transaction and commit all heads after its XID but before S. A non-sargable visibility predicate
does not itself create a change index. Index-only scans also need a visibility/bloat capture, not a heap-free claim.

This candidate proves useful visibility semantics. It does **not** yet prove the two-statement/row/block bound,
complete owner coverage, relevant-key classification or atomic consumer-specific behind maintenance.

### B. Serialized transactional stamp and latest-per-home change index

A scalar commit-ordered stamp is possible conditionally in a **single shared database**: every reduction updates
one common native log-control row, then its head/log in the SAME transaction, holding the control-row lock through
COMMIT. Increment by transactional UPDATE, not `nextval`. Store each home's last stamp, indexed `(stamp,home)`.
A normal start SELECT sees a consistent committed control/head state. A later writer cannot commit ahead of the
lock holder; if the holder is invisible at start, its later committed stamp exceeds the visible control stamp.
Final `WHERE stamp > :start` then reads D current home rows, even after ACK, without walking reduction history.
This is a visibility proof under that serialization schedule; ordinary sequence allocation lacks its lock.[P5]

It is not an approved global command or a production bound. The shared lock serializes all homes, introduces a
cross-home metadata dependency into single-partition commands, and cannot atomically cover multiple owner DBs
without an additional established primitive. Lock waits, retries, WAL/index churn, cut retention and availability
are real maintenance. A locked read started before another commit must not mix a newly returned locked row with
old-snapshot peers; use one consistent SELECT snapshot or retry the entire observation.[P5]
No current schema/call site provides this arrangement. An owner must establish its compatibility and cost before
considering it. The stamp alone also fails narrowed admission below; this is not a selected architecture.

Commit timestamps are optional, prunable timestamp metadata, not a transactionally indexed total order.[P6]
Logical decoding exposes commit-ordered changes, but a paused decoder misses an already committed reduction.
Decoding/catch-up to a proven current barrier and indexing it costs WAL/history work, statements and bytes; it
cannot be made free by naming an LSN.[P7] Neither mechanism currently closes the synchronous observation boundary.

### C. The unresolved join: relevant keys, homes and immutable executions

The smallest obvious fast read representation is one **registered definition/consumer/home** summary, indexed
both by `behind` and by committed last-relevant-change cut, retaining unknown-routing and subject-wide effects.
Start/final would key-resolve the actual observation/execution, read behind summaries and seek changed summaries;
own-row work keys the retained original/terminal set independently. This is a design candidate, not a table claim.

Three counterexamples expose its maintenance problem and the cheaper alternatives:

1. **Last-head-only key loss:** after start, one home removes relevant tag K, then changes unrelated J; both are
   ACKed. Keeping only the last cause J lets a stale NOT K execution serve. Retain all necessary key-change
   information, or a correct summary, through every live covered/start cut. Reading E log entries for one changed
   home is not bounded by `64+2*(B+D)` when E grows while B,D stay fixed.
2. **Per-key multiplication:** an index `(key,home,stamp)` over K query keys can yield K rows per changed home;
   DISTINCT/hash/JSON does not erase that work. At 32 keys and 4,096 homes this can be 131,072 inputs, versus
   8,256 rows allowed with B=0,D=4,096. A home-leading seek with K failed key probes still charges K index paths
   and blocks per home. Arrays/GIN summaries must charge encoded keys, rechecks, TOAST and maintenance too.
3. **Registration fanout:** a reduction affecting M registered definitions/consumers cannot synchronously update
   M summaries in a bounded domain command when M grows with population. Keyset paging through an indexed reverse
   definition relation can bound later repair steps, but publication must atomically detect its unprocessed tail.
   A global unknown bit during that tail blocks unrelated reads and can fail served share. Per-PIT/execution
   updates make fanout worse; no adopted global quota bounds these registrations. The owner-result quota does
   not cap public definitions, physical consumers or immutable observations.

An index of complete selected-input reverse locators is essential for foreign routing/restoration. It stores
identities and source-key relationships, not private facts, reusable permission or per-page witnesses. Registration
must either join the authoritative reduction barrier before publication or remain unready until bounded backfill
closes it. A target's own property key does not determine source-query irrelevance. No such native closure exists.

## Competing schedules and physical ACK

These schedules are falsifiable requirements for the actual future runtime, not claimed experimental results.

| Schedule | Required result / concrete shortcut failure |
| --- | --- |
| Lower allocation commits late | T1 allocates n on home A and waits; T2 allocates n+1 on B and commits; start takes n+1; T1 commits; final `stamp > n+1` misses A. Snapshot-XIP handles visibility but must pass its indexed cost; serialized UPDATE must hold its lock until commit. |
| Reduction then ACK during query | Retain immutable observation and start; execute zero-candidate NOT K or K-based order; reduce K on an excluded subject; genuinely repair local+foreign and ACK; final pending is empty. Changed relevant evidence must still prepare/restart the original execution. |
| Snapshot older than query start | Open PIT/build at C; reduce K and repair/ACK; start a new query S on that old observation. Comparing only S to final misses the already unsafe snapshot. Start must validate retained covered C as well; latest live ACK cannot advance C. |
| Overlapping source snapshots | Wold reads version v; another command changes source and Wnew repairs v+1. External versioning orders visible bodies while a version remains known, but Wold's later physical effect is not undone by a lost checkpoint CAS. |
| Lost dirty / ACK race | Repair through p reads old head; reduction p+1 commits; ACK blindly deletes dirty row. Final sees clean incorrectly. Reduction, ACK, head comparison and routing revision need one native serialization/CAS discipline. |
| Late foreign registration | Dependency owner reduces before a selected-but-ineligible source registers. Registration must inspect/catch up actual owner history and block publication until complete; looking only at visible indexed values loses restoration and negatives. |
| Crash / ambiguous HTTP | Sink effect may precede lost response. No ACK from assumed success; recover persisted bounded input/frontier, inspect actual winning version/visibility and dependencies. Replaying the old body after a newer deletion is unsafe. |
| Restore / log gap / move | Source key becomes eligible again; retained locators find it, own-source version advances. Pruned required log or moved/missing owner yields changed/unready, never empty/exhausted/zero. |

For the lost-dirty race, a same-row sketch is `ack := greatest(ack,p); behind := head > ack` under the same
home/registration lock that reduction maintenance uses, with exact generation/routing-revision checks. If reduction
wins first, ACK observes the higher head and leaves behind; if ACK wins first, reduction sets behind afterward.
This closes that race **only if** all affected summaries are atomically maintained. Prefix completion additionally
requires every earlier local/foreign repair, not merely the maximum successful position. A losing CAS must read
and verify a real competing winner. No DB checkout remains held across engine/foreign I/O.

The actual sink uses source-home position as external version (`search/document.ts:documentActions/bulkLines`).
A foreign target reduction does not advance that source position. Repairing a source with a changed body at the
same version returns 409 under external versioning; `writeIndexActions`' refresh can expose the OLD winner.
Dependent own-home source advancement and exact winner-body/definition evidence are missing prerequisites.

**Physical resurrection counterexample:** hold a real old external-version index request v before dispatch;
delete the document at v+1 and refresh; advance a checkpoint/putative ACK; allow delete-version retention to expire;
dispatch v and refresh. OpenSearch can accept it as a new document. In 3.9.0,
`InternalEngine.resolveDocVersion` forgets aged delete versions, `pruneDeletedTombstones` uses age/checkpoint,
and `VersionType.EXTERNAL` accepts a missing document.[O1] Long but finite `gc_deletes`, public candidate
suppression and a CAS after the physical write do not prevent this. Permanent soft tombstones are excluded.
`services/kernel/test/search/late-write-pruning.test.ts:194-354` contains real source/transport/GC and checkpoint-loss
schedules plus separate public/physical assertions. It was inspected, not run; its existence is no passing capture.

`aroundApply` is the existing place to enroll/admit and drain the **actual** source read and write. Local relay
pause waits its own promises, including withheld responses; it cannot prove another process or retry queue has
no old payload. OpenSearch's native add-write-block action drains in-flight writes across shards, with at least
two cluster-state updates; internal shard permits are not a public per-source lease.[O2] A retained write block
also prevents repairs; unblocking permits a still-held old client request. Task absence, connection closure and
request timeout likewise need a custody proof. No inspected API revokes all future external-version requests
belonging to an application consumer generation. Conditional seq_no/primary_term writes protect cooperating
requests; they cannot fence an already held unconditional/external write. No independent fence is deployed here.

A PIT retains the original reader/segments; refreshing the live index cannot sanitize that PIT.[O3]
Prepared generations similarly need immutable membership and guarded publication. Capture/first execution must
establish covered/start evidence before the engine snapshot it protects, or validate the intervening gap. Later
queries compare that SAME covered cut plus their execution start in the two observations; an extra capture sweep
is not free. Renewal retains identity/cut. Lost/expired/closed evidence prepares. Close must drain users before
releasing retained references; closing a PIT does not itself prove secure physical erasure of its segment files.

## Cold projection, erasure and owner dependencies

Cold projection begins from each **known subject**, not a new public population truth. The real
`semantic/page-subjects.sql:5-14` seeks `(route,subject_id)` under `semantic.subject`'s matching primary key;
`page.ts` binds partition epoch. Its subsequent lateral label query folds fact history and JSON: it is neither
cheap key enumeration nor complete public disclosure. Reuse the underlying internal key seek without hydration
for bounded work; do not expose a new Source/list API or copy the matcher.

For finite cold catch-up, retain an internal key frontier and authoritative initial coverage barrier. Concurrent
creation behind that frontier must enter the existing outbox/durable repair stream atomically, including creation
with no public output. A log bridge must cover the enumeration interval before activation; movement, a retained-log
gap or unknown registration coverage forces retained recovery/backfill. Never publish a mixed generation. Current
selection indexes must separately replace compact history/adoption-array folds with bounded native keysets.
No public producer or source-definition registration port currently proves this bridge. Null consumer means no
ACK, not a clean cold path; repeatedly restarting enumeration or preparing forever fails finite progress.

A5 all-role erasure includes public account-agent names, aliases, metadata and attribution in every live projection
generation, retained copy and old writer. `semantic/agents.ts:accountAgentId` identifies one stable node, not every
role. `account-agent-sync-label.sql` and the erasable-label trigger address that node's label/current-fact path.
`docs/deletion.md:27-65` requires indexed owner relations/exact artifact locators and actual minimized-source
completion. Semantic editorial/provenance and Zone source locators, Accounts shared-history custody, and Content
delivery participation must resolve their own affected subjects/dependencies. Those all-role completion ports are
missing. A revision counter cannot attest minimization; unknown custody stays incomplete. This report does not
duplicate their locator research or propose account/name/JSON scans, a new owner engine or fictitious none/erased.

Finite-progress proof would require: finite admitted relevant inputs; complete registration/routing; monotonic
retained frontier and settled effects; replay rereading at most one step; eventual successful owner/engine I/O;
all old writers resolved; and an indexed completion probe. Each dependency is currently conditional or missing.
An indefinitely ambiguous old request cannot be declared finished; a healthy quiescent fully known workload must
eventually finish rather than using that uncertainty as permanent preparation. Fair scheduling alone does not
repair an undiscoverable dependency or an unsafe sink. Existing DBOS/work/receipt infrastructure remains the host.

## Exact accounting and smallest next owner decision

Let K be actual retained dependency keys, A active snapshot XIDs, E retained relevant log entries, M affected
registrations and U registered owner backends. These are charged dimensions, not new admitted allowances.

| Work | Required accounting / unresolved term |
| --- | --- |
| Ideal maintained coverage | With a genuine one-row/home behind/change summary, `k + 2B + D` rows could fit `64+2(B+D)` if all controls/joins/retention satisfy the remaining fixed budget. This is algebra, not a measured plan. |
| Head vectors / packed vector | 8,192 head rows fail caught-up B=D=0. Just home/epoch/bigint position is 131,072 raw bytes across two vectors, before protocol overhead; aggregation cannot erase input work. |
| Snapshot candidate | A SRF rows plus D returned homes, O(A) seeks and `24+8A` retained binary snapshot bytes; scalar/array variants still copy/probe metadata. Dead tuples and buffers need native capture. |
| Key/history candidates | Up to K times homes, or E entries for one home; summaries shift work to O(M) writes/index/WAL/GC. Neither LIMIT nor a final one-home aggregate removes those terms. |
| Owners and registration | Per-owner start/final requires at least 2U statements; U>1 already exceeds shared coverage two. One catalog row cannot assert remote current availability without charged native coverage. |
| Whole direct read | `c<=min(600,6s+3)`, 6 catalogue searches or 3 owner keyset seeks, 3 rounds, `16+8c` points, `64+16c` PG rows, six blocks per budgeted row, response `16KiB+4KiB*c`, request `64KiB+1KiB*c`, 12 statements/backend and one connection/backend. Capture, query, final/status and own rows all share these. |
| Prepared/composed | Ready reads: `2s+2` candidates, two index reads. Page: R<=16, total slots<=128, `8+4R` statements/backend; maximum 816 candidates, 6,784 points, 14,080 rows, 72 statements, 96 searches. No extra safety bookkeeping allowance. |
| Repair/preparation | <=1,000 inputs/results, one frontier, `64+16*input` rows, eight points/input, 16 statements/backend, four searches, one connection/backend, 4MiB response. Charge rejected/lookahead/reread/failure, blocks and metadata work. |
| Lifecycle | One current and one building public generation per admitted definition; owner quota 32 and idle expiry 24h are existing constraints, not permission for unbounded active definitions/PITs/history or command fanout. |

The 64/512/4,096 matrix must independently grow population, matches, sparse nonmatches, unrelated history, owner
pools, alias groups, deep pages and privacy arrival rate, plus the composed 16-read/128-slot page. Fixed pages
need constant examined rows/bytes/statements and logarithmic blocks/engine iterator work. Measure actual
`next_doc_count+advance_count`, local/foreign latency and served/preparing share. Blocking every unrelated
reduction gives approximately `exp(-lambda*tau)` served share and fails as arrival grows; none of these candidates
has a capture proving otherwise. Backend rows, removed rows, blocks, wire bytes, SQL/engine operations and source
maintenance must be measured together, including late registration and failed/replayed work.

**Recommended next owner decision:** keep runtime work closed until Semantic/Search identify one native
registration/log layout that supplies BOTH a commit-visible indexed changed/behind path and complete old-writer
custody. Performance must validate its actual plans and maintenance under the existing numbers. Start with the
snapshot and serialized-row counterexamples above: decide whether either can meet owner placement and costs;
do not select a new engine/service, widen scope or adopt an unmeasured global serializer. Source identity/
immutable-definition resolution and all-role owner completion remain explicit prerequisites, not invented ports.

Minimal controlled falsification on isolated **19rc1/3.9.0** instances: initialize 4,096 real home rows; capture
tagged start/final `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plus complete statement/wire traces; run lower-XID late
commit, an old unrelated XID pin, growing A/E/K/M, lost-dirty CAS and missing-owner cases. For immutable execution,
hold real PIT/prepared query output, reduce K, complete actual local/foreign repair and ACK, verify pending zero
and old execution still blocked; repeat irrelevant-key and own-row cases. Hold actual old bulk before dispatch
and after native response, delete/refresh, force eligible GC, then release. Recreate the same name/new UUID and
exercise crash/recovery/late registration/restoration. Use only owned disposable data and `.temp/` artifacts;
never run cloned code. A primitive probe pass would still leave API/default and full growth acceptance unproved.

## Primary sources and licences

Reference clones were read as data; no dependencies were installed and no cloned code was built or executed.
Paths below are within `/home/edge/projects/rezics/rezics-next/.reference/`; reuse is recorded in its INDEX.md.
Shared pattern: native visibility, native index access, immutable readers and application repair ownership are
distinct mechanisms. Combining their labels is not a concurrency or cost proof. Recommendations concern native
designs in this repository's stack, not copying upstream files or long passages.

[P1]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/configure.ac
[P2]: https://www.postgresql.org/docs/19/sql-createindex.html
[P3]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/utils/adt/xid8funcs.c
[P4]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/include/catalog/pg_opclass.dat
[P5]: https://www.postgresql.org/docs/19/transaction-iso.html
[P6]: https://www.postgresql.org/docs/19/functions-info.html#FUNCTIONS-COMMIT-TIMESTAMP
[P7]: https://www.postgresql.org/docs/19/logicaldecoding-explanation.html
[O1]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/engine/InternalEngine.java#L815
[O2]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/admin/indices/readonly/TransportAddIndexBlockAction.java#L60
[O3]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/internal/PitReaderContext.java#L37

- PostgreSQL: `library-shelf-maintenance/postgres`, tag/commit [P1], PostgreSQL License (`COPYRIGHT`). Additional
  inspected files: `src/backend/storage/ipc/procarray.c:2082-2288`, `src/backend/commands/indexcmds.c:1859-1886`,
  `doc/src/sgml/{mvcc,logicaldecoding}.sgml`, `doc/src/sgml/ref/create_index.sgml`; [P3] lines 56-77,175-212,371-413,596-634.
- OpenSearch: `search-rating-populations/opensearch`, commit in [O1], Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`).
  Additional inspected files: `server/src/main/java/org/opensearch/index/{VersionType.java:109-124,engine/LiveVersionMap.java:417-438}`
  and `index/shard/IndexShard.java:5100-5104` under the same Java root; InternalEngine lines 1753-1780 cover pruning.
- Official OpenSearch documentation: `search-rating-populations/documentation-website`, commit
  [`9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`](https://github.com/opensearch-project/documentation-website/tree/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf),
  Apache-2.0 (`LICENSE`, `NOTICE`); `_search-plugins/searching-data/point-in-time.md`,
  `_api-reference/{document-apis/delete-document.md,index-apis/refresh.md}`. This docs commit is not claimed to be a 3.9 release tag.
