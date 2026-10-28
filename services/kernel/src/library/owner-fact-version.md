# Native owner fact invalidation prerequisite

[Owner predicates](../../../../docs/library-owner-queries.md),
[Library and Continue](../../../../docs/library-and-collections.md) and
[filtered-list cost](../../../../docs/filtered-lists.md#cost) own the consumer requirements.
This interface supplies private native invalidation metadata only. It activates no query, Continue,
Source2a public projection, source factory or prepared result, and proves no dynamic/profile API outcome.

## ABI and snapshot

`readOwnerFactVersion(client: Pick<PoolClient, 'query'>, accountId: string): Promise<bigint | null>`
is exported from `owner-fact-version.ts`. It validates the native routed account UUID with `routeOf`,
derives the route, and performs one exact `(route, account_id)` primary-key SELECT on
`library.fact_source_head`. It uses bigint throughout, without Number conversion. There is no caller route,
HTTP account selector, authorization oracle, checkout, transaction, callback, cache or write.
The trusted caller supplies its own already-authorized native read snapshot and reads actual facts in that
same snapshot. The helper neither authorizes that account nor establishes snapshot isolation for the caller.

Null means metadata is missing, never inferred zero or ready absence. A present version proves neither bootstrap,
complete canonical/source coverage, current permission, published identity epoch nor safe prepared rows.
Legacy/missing-head readiness requires separate bounded producer work. A separately complete actual native empty
proof may establish a direct empty result; this helper alone cannot. GET never inserts a head or repairs anything.
No backfill, all-owner scan, legacy chronology or fact/pin payload copy is introduced.

## Native coverage

The original `20261028003557_owner_fact_source_hooks.sql` covers Everything/state only: entry updates compare
owner/subject/state/pin; copy and session compare owner/subject/pin; assignments additionally compare label,
assignment identity, slot and deletion; label parents compare owner and deletion. Session lifecycle/activity,
copy kind/status and same-value entry winner-sequence changes were omitted. The newer owner-write schema
adds nullable bigint `entry.owner_write_seq`, independently of the structural source head.

The forward coverage migration replaces only the five UPDATE triggers, atomically under normal migration
semantics, with `AFTER UPDATE ... WHEN (OLD IS DISTINCT FROM NEW)`. All current native columns therefore
invalidate conservatively, including lifecycle, activity, holdings, winner sequence, live parent and reservations.
The original insert/delete hooks and `advance_fact_source_head` function/PK remain unchanged: four fact kinds
advance on insertion/deletion; parent creation alone still does not, parent deletion does. A true owner-key move
advances both old and new owner points; that behavior permits no implicit cross-home transaction.
Bigint overflow aborts the whole fact transaction. Rollback restores facts and metadata together.
Genuine SQL no-change rows do not advance. Receipt replay, branded noEffect and read-only GET must mutate
neither rows nor heads. Every actual row change pays its trigger; a multi-statement operation can advance more
than once. Consumers must not disable hooks or add a manual head increment to conceal this work.

`owner_write_counter.seq` remains independently owned by the state-write allocator: allocate once per successful
set/clear/Undo, never on observation, derived repair or payload purge. This version is not that ordering counter.
Original fact/pin rows remain truth. No public per-home log, private key, version response field, permission cache,
witness database or copied fact index is added. Terminal cleanup still removes the head last after fact hooks.

## Remaining consumers and evidence

Owner plans must combine the version with actual same-snapshot facts and full AST/order dependencies, current
source/disclosure/epoch/admission evidence, and complete canonical/index readiness. A version is never a cached
allow or proof of query completion, including NOT exclusions and ordering. Source2a consumes this actual helper
only after interface review; it adds no second Filter union or allowOwner flag.

Liked's delivered Content adapter is raw only: it provides no source version, epoch or disclosure observation.
Prepared Liked rows require a separately actually delivered actor-source observation/invalidation interface before
activation. This slice neither queries Content SQL nor invents a reader/version signature.

The native suite uses keyed raw storage fixtures solely to probe triggers, snapshots and metadata, including
bigint values above the safe integer boundary. It supplies no fake Access/source backend or authenticated
business/API proof, and implements no production state allocator. Legacy source-hook expectations that note,
amount and parent rename leave the head unchanged conflict with the conservative coverage now required;
those frozen tests require their owner's scoped amendment and are left untouched.

## Cost

### Read owner fact version

- Touches: one owner primary key, no facts/history and no writes.
- Bound: one SELECT, at most one result row, constant examined rows/statements and logarithmic shared blocks
  in head population.
- Growth check: the native suite uses the shared harness at 64/512/4096 unrelated heads and native session/change
  history, independently, with the selected owner/facts fixed. Actual SQL, examined rows and blocks are captured.

### Invalidate on native row mutation

- Touches: one existing head PK upsert per changed native row, or two on an actual owner-key move, in addition
  to the fact statement and its indexes.
- Bound: constant rows/statements per row, logarithmic blocks in the respective tables. Multiple changed
  rows/statements pay separately; no free trigger work or per-owner history scan.
- Growth check: the same shared native captures include keyed mutation and actual nested trigger SQL at
  64/512/4096, without planner forcing, a local catalogue classifier, slack or deadline changes. These primitive
  measurements establish no complete owner plan, composed-page budget, privacy observation or ready result.
