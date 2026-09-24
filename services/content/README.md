# Content owner core

`@rezics/content` owns PostgreSQL draft heads, immutable serialized JSON revisions,
local receipts, publication preparations and the Content outbox. `ContentCore`
accepts an injected `pg.Pool` connected to the isolated `content` database.
Call `migrateContent(pool)` during owner startup. It tracks its applied version
inside the Content database and is safe to call again.

`saveDraft` uses an expected draft head and operation ID. It preserves the exact
UTF-8 JSON bytes and a SHA-256 digest while deriving JSONB for structured reads.
The SQL transaction commits the revision, head, receipt, owner position and outbox
event together. A stale head receives a terminal receipt without a new revision.
Variant identity is immutable and independent of its language tag, so two variants
may share the same language.

`preparePublication` pins an exact committed revision and returns the reference
for a later guarded Main graph command. `settlePublication` accepts a terminal
graph receipt/position from a trusted outcome reconciler; pending or ambiguous
outcomes retain their pins. Active publications keep their pin. Rejected outcomes
release it only after a terminal proof. The module does not execute graph commands.
Callers may require the revision to be the current draft head and supply the
expected Content owner epoch; both are checked before a new pin is written. A
supplied owner epoch is also checked under the owner row lock at settlement.

`readExactBatch` requires one current batch authorization callback for the requested
revision, admits at most 64 distinct revisions and 4 MiB, and returns per-item
availability without a head fallback. The adapter verifies retained bytes against
the digest and JSONB. `readOutbox` provides a bounded owner-epoch/sequence window
for a future relay.

The integration test creates a disposable loopback PostgreSQL cluster under
`.temp/`, so it requires the pinned `initdb` and `pg_ctl` binaries. It does not
use or reset the developer Content database. Main/Access admission, graph adoption,
projection readiness, erasure and GC are integration work for later P0.8 slices.
