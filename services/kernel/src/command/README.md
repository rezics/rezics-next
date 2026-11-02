# Native commands

[The executor](command.ts) owns native command transactions, principal-scoped idempotency receipts and the
atomic domain/receipt/outbox envelope. [Access](../access/README.md) owns authorization; this module does not
duplicate its permission formula. [Commerce](../commerce/README.md#receipt-aware-native-refresh-admission-implementation-pending)
owns payment refresh composition. The metadata-only helper below is implemented in this core; Commerce refresh
admission remains an adopted contract with implementation and native schedule gaps.

## Existing execution and receipts

### Shared-history erasure

The supported native sink is `declareCommandHistory(tx, kind, { response, events })`. Owners declare typed
`HistoryScope` / `AccountReference` subjects and related parties before their first write, independently of identity.
The executor unions the genuine actor/principal/human/delegate evidence supplied by that attempt's verified Access
proof. Scope validation caps the whole production unit at 64 distinct accounts, 1000 events, 256 locator bytes and
64 KiB per copied payload. No JSON search or account-looking string inference occurs. A registered producer without
its declaration or verified identity evidence fails closed. HTTP input cannot provide either declaration or proof.

`access.account.preferences` has permanent command-kind ID 1. The mechanical
`library.entry.retention.purge` receipt has ID 2, with its original account episode principal and subject,
normalized deletion key and original native deadline digest. It synthesizes no active Actor.
`registerCommandHistoryKind` binds other permanent owner IDs (at least 1000) before composition.
IDs never follow runtime registration order. Receipt locators encode the actual persisted `rk1` version/token:
`(partition, principal kind/id, command-kind ID, key version, HMAC token)`. Version zero retains its exact native
meaning. Outbox locators encode `(partition, position, event sequence)`. Raw caller keys and private payload values
never enter locator keys. No-effect receipt locators use the same identity, even at position zero.

Guard materialization and SHARE locking precede owner writes and last until commit. The source fence and every
receipt/event association commit in that same serializable artifact-partition transaction. Foreign account roles
are recorded locally with their real route/id, without opening the account's home partition. An eraser seals the
same guard exclusively using the committed permanent erasure obligation, including an empty locator prefix.
A covered late producer commits no source, receipt, event or locator. Receipt hits create no new associations;
rollback and every serialization retry discard the declaration and acquire fresh verified evidence.

The default preference minimizer clears the physical response to JSON null and marks `payload_state=minimized`.
A matching authorized retry raises HTTP 410 `command_result_erased`, `retryable=false`, `effect_status=applied`,
without invoking the body or returning response/scope provenance. Authentication and current authorization still
precede receipt lookup. Metadata-only own completion remains a boolean/digest port, including position zero.
Other receipt kinds stay pending until their owners register actual result completion/transfer dispositions.

The delivered coverage is preference receipt/outbox custody and preference receipt response minimization.
All other command/effect/workflow producers, outbox payload minimizers and durable-copy minimizers remain runtime
gaps. An empty covered prefix is not a global none proof. No shared-history ACK or full erasure completion is made.

Custody costs O(declared accounts × artifacts × log H) local index work at the existing envelope/payload bounds.
Minimization touches one exact receipt and its at most 64 associations via `history_locator_artifact`, one committed
barrier and a native progress anchor. No receipt enumeration, account-prefix inverse scan or global ACK lookup occurs.
The native acceptance is `test/history/command-custody.test.ts`; `growth-command-custody.test.ts` uses the shared
harness/catalog classifier with unrelated same-partition receipts, locators and history at 64/512/4096.
`runCommand` validates native identity, partition, key and digest, prepares separately anchored authorization
without holding the resource connection, and runs the final authorization inside each serializable attempt.
Authorization precedes own-receipt lookup and body execution. A matching receipt replays before the body;
a changed digest raises `IdempotencyConflictError`. Receipt-only authorization retains its existing meaning.
Current principal kind/id, partition, command kind and native idempotency key identify the receipt; token bytes
and attribution are not an alternate principal. Native keys and SHA-256 digests retain the executor's existing
validation rules, including the 1–255-character key and exactly 32-byte digest requirements.

Successful domain mutation emits registered events and commits through the partition fence with its receipt
and envelope. SQL retries do not authorize reuse of stale external evidence. `noEffect` asserts that the body
wrote no domain data; it cannot hide coordination writes or registered work. Authorization finalizers are not
a place to conceal domain mutation. Existing replay, receipt, authorization and `noEffect` semantics stay unchanged.

### Receipt storage keys

HTTP and worker startup require `KERNEL_RECEIPT_KEYS`: one to four comma-separated
`version:base64url` entries, current version first, with distinct integer versions in 0–255
and at least 32 random bytes per key. Trusted composition may supply the same dedicated
`receiptKeys` ring directly. Never reuse current or retained `KERNEL_SESSION_KEYS` bytes.
The receipt ring is independent of ephemeral token defaults; missing configuration fails startup.
Native test factories explicitly supply fixed dedicated material.

Both normal and no-effect commands store only the current `rk1` HMAC token, framed with
version, command kind and complete principal kind/id. Caller key validation, digests,
responses, transaction IDs, positions (including zero) and authorization ordering are unchanged.
Readers compute at most four retained tokens and one exact raw candidate for pre-cutover rows;
there is no production backfill or raw write fallback. All seven native receipt consumers
use this codec. Checkout count probes exactly its two numbered outcomes, never a prefix range.
Each consumer has constant statement/row bounds and indexed O(log H) receipt access.

Keep every version for the lifetime of its receipts. Retiring a key requires explicitly
re-keying all receipts using that version first; never silently discard an old key. Pool
configuration rejects replacing or dropping retained material. This completes receipt-key
storage privacy only; the other shared-history erasure gaps remain open.

## Metadata-only own completion

The approved additive interface is:

```ts
hasOwnCommandCompletion(tx, { kind, key, digest }): Promise<boolean>
```

The command core implements this helper with a narrow [digest projection](read-own-completion.sql) of the same
receipt authority/key as the native [receipt reader](read-receipt.sql), using the [executor rules](command.ts).
It answers only whether a matching command completion exists: `true` for matching completion, `false` for absence. Digest mismatch remains the native
idempotency conflict, not `false`. It never returns a stored response, historical domain snapshot, receipt object
or payload-derived digest. It must work when response payload has been minimized but completion metadata is
legitimately retained; payload availability is not a completion requirement.

Use it only inside a live authorized native transaction. Validate the executor's current principal, partition,
native key and digest with its existing rules. Callers cannot supply a different principal or partition.
Reject calls outside that authorized live phase, including preparation, before authorization and after commit;
a pooled client, live-but-not-authorized transaction or copied/expired context is not a receipt capability.
The executor holds the normalized owner in a private WeakMap keyed by the exact transaction object, installed
only after execute authorization succeeds and removed before commit/rollback and on every attempt exit. A passed deadline
also expires the capability. Neither the public command context nor copied transaction descriptors convey it.
Commands without identity or explicit completed authorization have no receipt owner capability.
There is no public endpoint, module-local receipt SQL, anonymous/staff bypass, new permission or receipt oracle.

Retain the original apply authorization policy for the queried intent. Being authorized for some admission
command, or owning a receipt, is not authority for a different action/resource. The helper adds no authorization
alternative and does not move `runCommand` receipt lookup ahead of authorization. Current command context alone
must not be interpreted as permission to inspect arbitrary intents owned by that principal.

Commerce calls this helper only after normal service admission and the native order lock for the same immutable
order/Session/stable apply intent. That lock must cover the completion check and any subsequent claim. Matching
completion exits without domain mutation or provider read, using a rollback sentinel or native `noEffect` only
when this transaction wrote no domain data. An uncompleted intent may then perform a real revision claim with
the existing order-updated event, receipt and envelope. A completed A retry must not advance revision over
inflight B and then acknowledge A's old effect. The helper supplies completion metadata, not order locking,
refresh authority or cancellation-to-commit exclusion.

## Required native scope proof

[Native own-completion tests](../../test/command/own-completion.test.ts) use real `runCommand`, PostgreSQL,
Auth/JWKS, installed Access grants and anonymous resource eligibility. They cover same principal/partition/kind/key
completion and absence, digest conflict, native syntax validation, principal/home isolation, the original apply
policy's denial before lookup, minimized responses, and rejection of pooled/preparation/before-authorization,
expired/copied/rolled-back/committed and identity-free contexts. Actual captured SQL selects only `request_digest`
with the full receipt key; large and minimized stored responses return the same metadata bytes. Read-only helper
commands use `noEffect` without a receipt and leave the partition head, receipts, events and write basis unchanged.
Legacy account writers and principal callers share the receipt namespace, and ordinary replay retains its response
and original transaction identity. Existing native replay, receipt-only and `noEffect` suites remain required.
These core tests establish no Commerce claim, combined routing or cancellation-to-commit exclusion.

Commerce's native default-worker/HTTP fixture proof must also cover completed A retry while newer B is admitted,
checking the same locked order and unchanged revision/provider-read count, plus crash-after-commit replay.
Test barriers observe and control timing; they never replace native receipt, queue, CAS or settlement policy.

## Cost

### Metadata-only own completion lookup

- Touches: one stable completion PK under the current authorized principal and partition, native key/digest
  validation and live-context checks. No history scan, payload disclosure, domain mutation or cross-home checkout.
- Bound: constant keyed lookup work; a selective B-tree probe has logarithmic blocks as unrelated receipts grow.
  Charge metadata bytes, actual statements, retries and pool time. Authorization and a caller's order lock/claim
  retain their own costs; this helper does not establish their bounds or shared dispatcher cost.
- Growth check: require real native matching/absent/conflicting and minimized-payload lookups at three legal
  unrelated-receipt/history scales, holding the selected key and metadata size fixed. Include denied and expired
  context cases and measure examined rows, buffers, statements and bytes. The native own-completion growth test
  seeds 512/4,096/32,768 legal same-owner, same-partition unrelated receipts with the selected keys fixed. It captures
  actual plans, rows, buffers, statements and wire bytes for matching/absent/conflicting/minimized cases and a denied
  zero-lookup path. It requires constant rows/statements/bytes, logarithmic blocks and no receipt sequential scan.
  The separate expired-context test requires zero receipt statements. The check log records the measured samples.

## Operational transactions

Library follow-count source bootstrap and current-source work are active work-step consumers. Their owner-local
counter mutex and native account-state share bind bounded immutable-key coverage; source continuation intents use
the same operational client and contain locators only.

The additive [operational executor](operational.ts) supports the Collection members GET exception in
[dynamic Collections](../../../../docs/dynamic-collections.md). It is not a command. It writes only the
consumer module's derived preparation records and durable work intents. It writes no receipt, domain event,
grant, resource header, outbox envelope or write basis, and never advances the partition position.
`runCommand`, including replay, `noEffect` and its statements per attempt, is unchanged.

The frozen entry signatures are:

```ts
runOperationalTransaction<T>(
  pool: Pool,
  options: OperationalOptions,
  body: (tx: OperationalTransaction) => Promise<T>,
): Promise<T>

enqueueIntent(tx: OperationalTransaction, intent: {
  queue: WorkQueueName;
  workflowName: string;
  workflowId: string;
  input: Readonly<{ accounts: readonly string[]; [locator: string]: unknown }>;
}): Promise<void>
```

Both functions are exported by `command/operational.ts`. `OperationalTransaction` exposes only `query` and
is branded separately from command transactions. Common options are `partition` (0–4095), `kind` (1–255
printable ASCII characters identifying the operation), `accounts` (at most two distinct routed account ids),
`workClient` (the existing `createWorkClient` result), optional absolute `deadline`, and optional trusted
service `clock`. There is no receipt option. The executor copies and sorts account ids before any attempt.

Request mode adds `mode: 'request'`, native account `principal` and `basis` from
`principalCommandIdentity(verifiedActor)`, and mandatory `authorization` from the same
`accessCommandAuthorization` path as `runCommand`. The authorization binds the actual request actor, action
and resource; its resource route must belong to `partition`. No separate body principal or partition is
accepted. Access verifies the attribution against the authenticated request actor. There is no anonymous,
staff, receipt-only or identity-free request bypass.

Work-step mode adds only `mode: 'work-step'`. It has no actor, bearer, principal, basis or authorization.
The registered DBOS step passes the intent's recorded partition and account ids again. This mode authorizes
no disclosure: later requests must obtain current Access authorization before disclosing prepared data.

Each attempt enters the command gate, mints one authoritative time, then prepares Access evidence without
holding a resource connection. On resource checkout it starts SERIALIZABLE with the executor's 200ms
`lock_timeout` and remaining deadline as `statement_timeout`. Access final authorization runs at this same
time before any write; receipt-only authorization denies. Next a receipt-free sibling of the no-effect
fence probes the active partition primary key `FOR SHARE`, followed by each named account primary key in
id order. These use `shareAccount`'s exact SQL and active/unfenced rule and retain their locks until commit.
`shareAccount` itself continues to require a live command transaction. Only then does the body run; any
supplied authorization finalizer must succeed before commit as well.

The operational executor lends Access its attempt time but never installs command, callback or receipt
owner authority. `currentCommand`, `registerCommandCallback`, `hasOwnCommandCompletion` and command event
emission are unavailable and throw. Copied or completed operational transactions cannot enqueue work.
Body errors, fence refusals and deadlines roll back derived records and workflows together. Serialization
failures (`40001`), deadlocks (`40P01`) and lock timeouts retry with fresh time and Access evidence until the
same `deadlineFor` request budget, with native backoff. Access contention retains its typed error on expiry.
Inactive partitions and expired deadlines raise the existing retryable `CommandUnavailableError` (503).
An account fence refusal raises `LifecycleDeniedError`; consumers map it as Access maps that account's reads.

### Atomic intent and recovery

`enqueueIntent` passes the transaction's own pg connection to DBOS 5.4.6
`DBOSClient.enqueueInTransaction`; it checks the live exact operational transaction. The input must name
exactly the fenced `accounts`. All other input fields are consumer-owned locators only (ids, keys,
generation), never private facts or payloads. Only existing native queues are accepted.

[Server composition](../server.ts) creates both kernel pool and work client from the same `DATABASE_URL`.
[Worker composition](../worker.ts) also passes that kernel URL and pool to `createWorkClient` and
[composeWork](../work/registry.ts). DBOS uses schema `dbos` in this same kernel database; there is no separately
configured system database. Enqueue acquires no second connection, adds no intent table, relay, scheduler or
queue, and commits or rolls back with the consumer record.

Use a deterministic `workflowId` and no `deduplicationID` or `duplicationPolicy`. The SDK's
`ON CONFLICT (workflow_uuid) DO UPDATE` returns an existing workflow and preserves its original input.
Conflicting workflow name or queue is a programming error. The work client checks the name and queue in
the SDK's returned upsert row, adding no query; the SDK alone only warns about a different queue.
Concurrent workflow inserts can raise serialization failures, which the operational executor retries.

The body owns idempotence using its derived record's uniqueness. For example, use
`INSERT ... ON CONFLICT DO NOTHING RETURNING`, then enqueue only when a record was created. A duplicate
request returns the existing preparation without another write. Never enqueue after commit: that loses
intent custody if the producer crashes. An already committed intent is an ordinary DBOS workflow. The
existing registered work modules and runtime recover it after restart. [Workflow retention](../work/retention.ts)
deletes only terminal workflows; an ENQUEUED or PENDING intent survives retention.

An operational intent is a **shared-history record kind** (durable work naming accounts), covered by
accounts' `shared-history` erasure participant. Its input contains locators only. The consumer's derived
records belong to that consumer's own erasure participant.

The [native test](../../test/command/operational-transaction.test.ts) uses PostgreSQL, Auth/JWKS, installed
Access grants, actual captured SQL and a test workflow registered through the existing work runtime. It
proves atomic commit/rollback, refusal before body, permission denial, deadline expiry, concurrent uniqueness,
unchanged command state, separate capabilities, name/queue conflicts, producer process crash and runtime
stop/restart, and account fencing between intent commit and work-step apply. Concurrency and crash schedules
use barriers, not elapsed-time guesses.

### Cost: operational transaction attempt

- Touches: one gate entry, one time mint; request-mode Access preparation and finalization as `runCommand`;
  one partition primary-key probe `FOR SHARE`; one account primary-key probe `FOR SHARE` per fenced account
  (at most two); the body's statements; per intent, one `dbos.workflow_status` insert and one
  `dbos.workflow_input` insert. No receipt lookup or partition position update.
- Bound: constant statements and examined rows for fixed body and intent count; logarithmic blocks in
  partition, account and workflow tables; retries bounded by the request deadline.
- Growth check: [request and work-step measurements](../../test/command/operational-transaction-growth.test.ts)
  grow unrelated workflows, receipts and accounts through 512/4,096/32,768, holding the selected key, body
  and input fixed. They require constant statements and rows, logarithmic buffers and no sequential scan
  of `dbos.workflow_status`, `core.receipt` or `access.account`.

### Cost: intent recovery

- Touches: existing DBOS queue dequeue and recovery for one workflow; no kernel statement beyond the
  work-step transaction above.
- Bound: unchanged DBOS per-workflow recovery; no kernel history scan.
- Growth check: the work-step measurement above covers kernel cost. Native process/runtime restart is a
  correctness test, not a recovery cost measurement.

The default shared-history worker now seeks all fixed homes and invokes exact receipt/outbox/SDK minimizers.
`HistoryRegistry.registerOwner` supplies actual native consumer readiness; unregistered receipt kinds retain a
concrete gap. This extends preference cleanup without declaring other producers converted. Ordinary record purge
needs the selected Semantic source authority and original record-to-copy inventory; account receipt custody alone
cannot identify an ordinary record's copies. The Accounts receiving signatures exist but fail closed until those
native source and inventory ports are delivered.

## Selected command dispatch lifetime

`command/dispatch-lifetime.ts` supplies the additive trusted-server entrypoint:

```ts
withCommandDispatchLifetime<T>(
  pool: Pool,
  deadline: number,
  owner: CommandDispatchOwner,
  body: () => Promise<T>,
): Promise<T>

type CommandDispatchOwner = Readonly<{
  original: object;
  validate(): void;
  reserve(allowance: CommandDispatchAllowance): void | Promise<void>;
}>;
type CommandDispatchPrice = Readonly<{ work: WorkDimensions; engineRequests: 0 }>;
```

The owner closes over its genuine original grant, selected callback and reservation operation. `validate`
**synchronously** rechecks that exact grant/callback, Pool, unchanged absolute deadline and revocation state;
an async validator is refused before dispatch. `reserve` must hold the complete `allowance.total.work` in one
atomic reservation on that original, including the disjoint `allowance.cleanup`, or throw. It may await;
Core revalidates on return. Reservations remain spent on error, expiry, rollback or lost responses. Core does
not mint a grant, select another Pool, construct a finite payer, refund work or price a foreign child.

Inside `body`, invoke the genuine `runCommand(pool, { partition, deadline }, ...)` once, optionally through
`withSingleCommandAttempt`, returning `noEffect` from its body. The exact native transaction alone has command,
resource and callback association. The lifetime binds its raw checkout, controls, authoritative time, fence and
commit, plus before/after-await liveness for Promise body queries. Body SQL remains charged by its genuine owner.
Synchronous validation also runs on native context/callback access. Copied/reflected callback symbols confer no
optional-path transaction authority. Callback and streaming pg query overloads are unsupported in this profile.

One scope admits one command. Reuse, concurrency, nesting and overlapping scopes on the same `original` object
are refused. A fresh sequential scope needs fresh genuine owner admission and reservation. Returning or throwing
from the scope while its descendant command is running closes effects immediately and waits for that command's
existing cleanup/release. Escaped transactions and late query results remain closed. Actor, principal, receipt,
authorization and custom-clock options refuse before reservation/checkout. Events, registered work callbacks and
native source/source-set associations refuse before final controls or source finalization. There is no retry,
writable wait or second checkout in the optional profile. Ordinary overloads and policies remain in place.

### Cost: selected native no-effect controls

`COMMAND_DISPATCH_CONTROLS` exports the literal components below. Each exposes `work` with all eight
`WorkDimensions` and `engineRequests: 0`. `COMMAND_DISPATCH_ALLOWANCE` exports `profile: 'single-no-effect'`,
`components`, `effect`, `cleanup` and `total`; `CommandDispatchAllowance` is its exact type.
Core admits each named effect control once in the stated order and records it before dispatch; unknown,
repeated or out-of-order controls refuse before IO. Cleanup is one-shot, on the same client, held before BEGIN,
and does not consult expired effect authority. Failed BEGIN and failed/lost COMMIT still consume their dispatch.
Failed cleanup discards the client and reports both errors, retaining the original error as cause.

| Operation                          | Touches                                                                 | Bound (rows / points / statements / bytes / empty seeks) | Growth check                                                             |
| ---------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `checkout` and lifetime validation | Same Pool, original callback, immutable deadline; gate and one checkout | 0 / 0 / 0 / 0 / 0                                        | Fixed local association; no SQL                                          |
| `begin`                            | SERIALIZABLE BEGIN                                                      | 0 / 0 / 1 / 0 / 0                                        | Fixed control                                                            |
| `lockTimeout`                      | Local 200ms setting                                                     | 0 / 0 / 1 / 0 / 0                                        | Fixed control                                                            |
| `statementTimeout`                 | Local remaining absolute deadline                                       | 0 / 0 / 1 / 12 / 0                                       | At most ten decimal digits plus `ms`                                     |
| `time`                             | One scalar UTC `transaction_timestamp`, no index                        | 1 / 0 / 1 / 40 / 0                                       | Native bounded scalar projection                                         |
| `finalStatementTimeout`            | Refresh remaining deadline before fence                                 | 0 / 0 / 1 / 12 / 0                                       | Same bound; no extension                                                 |
| `noEffectFence`                    | One active partition PK `FOR SHARE`; null receipt branch writes nothing | 1 / 1 / 1 / 105 / 1                                      | One key at unrelated partition/history scales; logarithmic B-tree blocks |
| `finalize`                         | Actual native finalizer with no declared source or source set           | 0 / 0 / 0 / 0 / 0                                        | Foreign registrations refused; actual body returns without SQL           |
| `commit`                           | Native COMMIT                                                           | 0 / 0 / 1 / 0 / 0                                        | Fixed control, including failed/lost response                            |
| `cleanupRollback`                  | Separate native ROLLBACK after any reached failure                      | 0 / 0 / 1 / 0 / 0                                        | At most once; no new allowance                                           |

The effect sum is **2 rows, 1 point, 7 statements, 169 bytes, 1 empty seek**. Adding cleanup gives
**8 statements**, with the other dimensions unchanged. Candidate keys, identity metadata rows and witness keys
are zero: these controls enumerate none of those foreign families. `engineRequests` counts external engine
operations, not PostgreSQL statements, and is zero here. No control retries. A partition miss still pays its one
index seek; the row bound stays prepaid even when no row is returned. No receipt/outbox/basis writes are reached.

Bytes count compact JSON bindings and nonempty projected row arrays, plus variable timeout-literal payloads;
fixed SQL text, protocol framing and empty control results have no payload charge. The time projection is bounded
**in SQL before IO** by `varchar(29)` after UTC formatting: at most six year digits and 23 fixed date/time
characters, giving `[{'at': value}]` 40 JSON bytes (with JSON double quotes). It preserves microseconds.
The fence's validated partition (0–4095), native UUID and null receipt have at most 50 binding-array bytes;
its one projected positive int32 epoch and nonnegative int64 decimal position have at most 55 row-array bytes.
The native key/type/projection enforce those limits before IO. Deadlines beyond signed-int32 milliseconds are
refused before checkout, bounding both timeout literals to 12 bytes. There is no caller-sized control payload.

[Native lifecycle outcomes](../../test/command/dispatch-lifetime.test.ts) cover the exact executor and SQL, before
and after-await refusal, copies/escape/reuse, insufficient funding, single-attempt fencing, failure/cleanup and
ordinary receipt ordering/replay. They are authored and UNRUN at this source handoff. Full Kernel acceptance and
native growth evidence remain owed through the controller; typing is not that proof. The fixture owner port is
not physical/private Accounts History authority. Accounts must adapt its genuine original validator/reservation;
Source scheduling/maxima, whole-original Source/Library prices, receiving and physical writer closure remain their
owners' operands, unavailable rather than zero when absent. No History consumer is converted by this producer.

### Publisher activation coordination and recovery

[Publisher coordination](publisher-coordination.ts) exports `runPublisherActivation(pool,
{ input, bodyWork, deadline?, clock? }, body)`, `resolvePublisherActivation(pool, input, deadline)` and
`cleanupPublisherResults(pool, deadline, limit?)`. These use the existing native executor, private transaction
association, absolute deadlines and rollback. One invocation makes one attempt; contention may be scheduled again
with the same immutable input. There are no runtime prices, funding records or receiving gates.

Semantic owns the `activation-step` input and result and the bounded body. Core snapshots that input before
checkout, then inserts/locks its exact operation row before calling the body. The canonical original key binds
root/phase/activation/position; the input digest also binds episode and original deadline. A changed binding
refuses before effects. Concurrent processes serialize at this primary key; an uncommitted locator is no proof.
The body receives the actual `currentCommand` transaction and must await its queries. `bodyWork` declares finite
owner-derived dimensions; Core enforces its statement count and lifetime. Row/fanout/byte bounds remain structural
owner obligations. `publisherCommandWork(bodyWork)` adds the static Core components; Semantic's canonical
representation and bounded body constants are additional operands, never inferred to be zero.
Core invokes at most twelve Semantic selections, three result encodes and one result decode per execution
including canonical verification; replay/resolution use at most seven selections, one encode and one decode.
Those finite representation multiplicities are additive with the owner's body work.

The canonical [activation result](publisher-activation-result.ts), its digest and actual fence metadata commit
in `core.publisher_operation` in the same serializable transaction as the body. The coordination branch advances
the partition fence with an empty outbox input: it creates neither an event nor a receipt/write basis, and never
claims `noEffect`. Ordinary authorization, receipts and event validation keep their existing paths. The mechanical
API grants no public authorization or publication authority. It accepts only canonical Semantic activation results,
refuses callbacks and History associations, and cannot finalize publication on behalf of Semantic.

A matching row returns the exact canonical result and original transaction metadata without invoking the body.
The resolver reads committed database evidence, returning `committed`, `conflicting` or `uncertain`; absent or
minimized evidence stays uncertain. A fresh resolution deadline does not alter the immutable input deadline.
A failed/lost COMMIT response still throws; a later lookup establishes completion. Canonical caller buffers and
precommit transaction IDs confer no completion authority. Semantic's existing scheduler/checkpoint wrapper does
not yet pass the immutable canonical input; this exported body callback is the minimal local integration contract,
with phase/body binding still owned by Semantic.

Static Core costs below use the existing eight work dimensions. Candidate keys, identity rows and witness keys
are zero; PostgreSQL MVCC/index maintenance stays within the engine boundary. Each exact key costs O(log H),
independent of unrelated operations. Bytes conservatively include SQL, scalar parameters and bytea hex transport.

| Component                     | Rows | Points | Statements |  Bytes | Empty seeks |
| ----------------------------- | ---: | -----: | ---------: | -----: | ----------: |
| Controls, including rollback  |    2 |      1 |          9 |   8192 |           1 |
| Association insert/lock/store |    4 |      8 |          3 | 409600 |           2 |
| Resolution lookup             |    1 |      1 |          1 | 266240 |           1 |
| Cleanup batch, at most 100    |  200 |    300 |          1 |  32768 |           1 |

Controls cover checkout/release (zero SQL), the executor's two BEGIN dispatches, lock timeout, initial/final
statement timeout, scalar authoritative time, one partition fence, absent-source finalization (zero SQL), COMMIT
and one same-client ROLLBACK including a failed COMMIT. Association bounds cover one INSERT plus its partition FK,
one locked PK lookup and one result UPDATE, including PK and retention-index work. At most 65,536 canonical result
bytes are stored per operation; lookup and storage carry at most twice that in bytea wire form plus fixed overhead.
Association also includes three bounded Core digest passes and one defensive copy (six result-size passes total);
resolution includes its digest and copy (four passes total). The separate Semantic representation multiplicities
above cover canonical encoding/decoding rather than hiding those operations in the SQL operand.
Replay uses a subset of association/controls. Resolution adds its lookup to controls; cleanup adds its batch to
controls. No retry/second checkout or foreign body is included in those constants.

Results are retained until 30 days after the immutable input deadline. The partial retention index selects at most
100 expired payloads by `(partition_no, retain_until, original_key)` and minimizes them in one native coordination
transaction. The selection reads at most 100 rows and updates at most 100; points include selection, exact UPDATE
and removal from the partial index. The immutable binding, result digest and fence metadata remain as a tombstone,
so minimization cannot turn an old retry into another effect. Tombstones are retained indefinitely; total retained
identities grow with completed operations, while every lookup and cleanup unit stays bounded.

Decision: Use a same-transaction operation row and canonical activation snapshot; retain an immutable tombstone
after bounded result minimization so cleanup cannot repeat an effect. Semantic supplies finite body work and phase
behavior through the native Core API.

## Selected Source native consumer fence dispatch

The separate trusted server entrypoint is exported from `dispatch-lifetime.ts`:

```ts
withSourceFenceCommandDispatchLifetime<T>(
  pool: Pool,
  deadline: number,
  owner: SourceFenceCommandDispatchOwner,
  accountId: string,
  body: () => Promise<T>,
): Promise<T>

type SourceFenceCommandDispatchOwner = Readonly<{
  original: object;
  validate(): void;
  reserve(allowance: SourceFenceCommandDispatchAllowance): void | Promise<void>;
}>;
```

The callback returns its ordinary result unchanged, normally the genuine `CommandOutcome<T>` from one
`runCommand(pool, { partition, deadline }, body)`. The selected account is an immutable primitive with the
**existing catalogue's full lowercase UUID domain**, including nil and every version. The only admitted command
options are own data properties `partition` and the exact absolute `deadline`. The same original/Pool/deadline,
synchronous validation and atomic pre-checkout reservation obligations above apply to this distinct owner type.
The old `CommandDispatchOwner.reserve`, entrypoint and single-no-effect allowance retain their types and values;
they never receive the Source allowance. Price declarations, casts and request data confer no original authority.

The Source profile admits authentic `noEffect(null)` and `noEffect({ fence: null })` (and preserves ordinary value
semantics), or exactly one `com.rezics.semantic.erasure.progress.v1` event. Its subject and sole data property
`accountId` must equal the selected account. Descriptor inspection rejects extra fields, getters, proxies,
custom prototypes/serializers, forged empty-event results and non-singleton arrays **before** serialization.
Core snapshots only those bounded event strings, then retains the actual catalogue JSON round trip/schema check
and the real `fence.sql`/outbox path. The foreign result value is never serialized by this receipt-free profile.
Callbacks refuse at registration, including late descendants; History source/source-set and agent associations
remain unsupported and their ordinary validation guards remain installed. Absent receipt, identity, authorization
and basis options cannot reach receipt reads, basis writes, History receipt recording or authorization hooks.

Actual prepared `retainIdentityScopeConsumerFence` in `semantic/identity-scoped-observations.ts` and
`writeIdentityScopeConsumerNativeCommit` in `semantic/identity-epoch-native-commit.ts` use `currentCommand` and body
SQL. They register no callbacks or History associations. Source owns both SAME Library seal verifications,
summary/prior receipt/conflict reads, native component read/insert/read and immutable consumer obligation insert,
as well as its grant, original scheduling and invocation multiplicities. This Core producer changes none of them.

### Cost: selected Source fence controls

`SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS` contains literal complete eight-axis components, each with
`engineRequests: 0`. `SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE` exports `profile: 'single-source-fence'`, those
`components`, `branches.noEffect`, `branches.event`, `effect`, `cleanup`, `total` and one-attempt `maxima`.
`SourceFenceCommandDispatchAllowance` is the exact exported type.

| Core component              | Anchors / payload                                                                           | Rows / points / statements / bytes / empty seeks |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| accountSelection            | Existing lowercase UUID validation of the selected immutable account                        | 0 / 0 / 0 / 36 / 0                               |
| checkout                    | One original Pool acquisition, guarded before and immediately after, within release custody | 0 / 0 / 0 / 0 / 0                                |
| begin                       | SERIALIZABLE BEGIN, including failure                                                       | 0 / 0 / 1 / 0 / 0                                |
| lockTimeout                 | Fixed 200ms setting                                                                         | 0 / 0 / 1 / 0 / 0                                |
| statementTimeout            | Original deadline, at most ten digits plus `ms`                                             | 0 / 0 / 1 / 12 / 0                               |
| time                        | SQL-bounded authoritative UTC scalar projection                                             | 1 / 0 / 1 / 40 / 0                               |
| eventShape                  | Fixed type (39), subject (36), account (36) string validation                               | 0 / 0 / 0 / 111 / 0                              |
| eventSerialization          | Catalogue JSON round trip of `{ "accountId": UUID }`                                        | 0 / 0 / 0 / 52 / 0                               |
| eventValidation             | Existing compiled catalogue validator's fixed JSON payload                                  | 0 / 0 / 0 / 52 / 0                               |
| finalStatementTimeout       | Same immutable deadline                                                                     | 0 / 0 / 1 / 12 / 0                               |
| noEffectFence (alternative) | Partition PK SHARE probe, null receipt                                                      | 1 / 1 / 1 / 105 / 1                              |
| eventFence (alternative)    | Partition point UPDATE and one outbox INSERT; 281 binding + 55 projection bytes             | 2 / 2 / 1 / 336 / 1                              |
| finalize                    | Actual History finalizer with absent source and source-set associations                     | 0 / 0 / 0 / 0 / 0                                |
| commit                      | Native COMMIT including failed/lost response                                                | 0 / 0 / 1 / 0 / 0                                |
| cleanupRollback             | Separately held, one-shot ROLLBACK on the exact client                                      | 0 / 0 / 1 / 0 / 0                                |

Safe assembly: sum the common controls, then add **one** supported branch. The no-effect branch has 2 rows,
1 point, 7 statements, 205 bytes and 1 empty seek. The event branch has 3 rows, 2 points, 7 statements,
651 bytes and 1 empty seek. `effect` is their coordinate-wise maximum, **not their sum**; `total = effect + cleanup`
has 8 statements and otherwise the event branch dimensions. Owners atomically reserve this complete `total`
from the same genuine original before checkout, keeping cleanup disjoint from effect authority. Body SQL and
Source/Library whole-original multiplicities must be composed separately using their delivered declarations;
unavailable declarations are never zero and this export supplies no invented body ceiling.

Bytes use the existing compact payload boundary (fixed SQL, framing and empty control results excluded).
There are four 36-byte UUID strings in the event plus transaction binding: subject, data.accountId, generated
native event ID and transaction ID. The JSON event array is exactly **205 bytes**, including the 39-byte type,
fixed property names/punctuation and generated 36-character UUID. The binding tuple
`[partition, JSON.stringify(events), transactionId, null, null]` is at most **281 bytes**, using the validated 0–4095 partition;
`SOURCE_FENCE_BINDING_BYTES` exports this derivation. Reylo's PostgreSQL adapter serializes the JSONB event input to a string before
calling pg; this tuple bound includes its 18 escaped quotes plus two string delimiters (20 bytes beyond
the 261-byte logical tuple). SQL null basis and receipt remain null parameters. `fence.sql` returns only epoch/int64 decimal position, at most **55 bytes**
for the one-row array. It cannot return `node` or `moved_to`. The actual native fence still inserts one outbox
position with `event_seq=0,event_count=1`; null basis and receipt make their INSERT branches unreachable.
The catalogue data serialization is exactly **52 bytes** and its schema-validation component also consumes
that payload. Account selection validates 36 bytes once; event shape validation compares the 111 fixed string bytes; result values remain foreign. No caller
string cap or guessed whole allowance supplies these bounds.

The event fence's two rows/points cover the partition update and exact new outbox key. A failed/empty fence
still consumes its prepaid bound, including one empty seek; it throws before partition projection, writable
wait or contention retry. One command claim, one ordered control sequence and one selected result enforce
one checkout/attempt/fence and at most one event. Candidate keys, identity metadata rows and witness keys are
zero: these controls enumerate none of those families. External engine requests are zero; PostgreSQL statements
are charged on their own axis. Engine MVCC visibility work remains under the architecture's accepted engine
boundary. Finalization is genuinely zero SQL: `finalizeCommandRecordSources` awaits
`finalizeCommandRecordSourceSet`, whose absent declaration returns, then sees no small sources and returns.
The profile refuses associations, and Promise body-query guarding forbids late finalizer SQL from descendants.
Normal History/catalogue guards still run; no empty registration is interpreted as global coverage.

Every reached await has original lifetime validation on entry and settlement, including the genuine event fence
and COMMIT. Closure/revocation/expiry never refunds attempted work. Effect authority closes before cleanup;
only the already held same-client ROLLBACK survives it. A failed/lost COMMIT rejects publication certainty even
when the database committed. Cleanup failure discards that client and preserves both failures. No refill,
new payer, second checkout or deadline extension is available. Ordinary command retry/moved routing, principal
and denied-replay ordering retain their existing paths.

The authored [focused outcomes](../../test/command/dispatch-lifetime-source-fence.test.ts) use the genuine executor,
private native context and actual native component writer, plus independent literal prices. Existing stronger
no-effect and ordinary fixtures remain unchanged; no obsolete assertion required removal. These native tests,
full Kernel acceptance and growth/physical closure are **UNRUN** at source handoff. Owner-port fixture ledgers
prove no production private funding. Source activation, genuine grant composition, receiving custody and complete
Source/Library original quotes remain independent owner obligations; this producer alone establishes none of them.
