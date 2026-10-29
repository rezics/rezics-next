# Native commands

[The executor](command.ts) owns native command transactions, principal-scoped idempotency receipts and the
atomic domain/receipt/outbox envelope. [Access](../access/README.md) owns authorization; this module does not
duplicate its permission formula. [Commerce](../commerce/README.md#receipt-aware-native-refresh-admission-implementation-pending)
owns payment refresh composition. The metadata-only helper below is implemented in this core; Commerce refresh
admission remains an adopted contract with implementation and native schedule gaps.

## Existing execution and receipts

### Shared-history erasure

Every command result declares a typed account scope covering every account copied into the result or its events,
including actor, human, delegate, operator and subject roles. Actor, human and delegate references are captured
automatically from the command context. No-effect receipts declare and capture the same scope even when no domain
write or event occurs. Receipt persistence stores a versioned keyed-hash token of the caller's idempotency key;
callers continue to send the raw key, but raw keys are never persisted. The key ring stays available while receipts
using it can be replayed. If a receipt has been minimized for erasure, a matching retry still returns the erased
result from the retained receipt skeleton and never reconstructs the removed response. Typed scope capture,
no-effect capture and erased-result replay remain open runtime gaps.

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
