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

The installed `POST /v1/content-drafts` path verifies Account `work:edit`, an
exact `content.draft` Access grant for the acting subject and current Work, then
calls this owner CAS. Its immutable provenance binds the author, Access admission,
rights attestation, predecessor and request digest to the exact saved bytes.
Legacy internal `saveDraft` calls without that proof remain private drafts and
cannot become publicly search eligible. The Content owner validates proof/intent
consistency; the public eligibility boundary also reads the independent Access
ledger before trusting it. The original-contribution basis is an author
attestation, not an adjudication of copyright ownership.
After a strong Access fence, `cancelDraft` takes the same operation lock as
`saveDraft`. It retains a winning save receipt or commits a cancellation receipt
that prevents a delayed claimed writer from saving. Scope and principal
revocation can then seal the matching Access admission from the Content position.

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
for the Content projection relay. Migration 002 adds a per-consumer durable
checkpoint. `ContentProjectionCursor` initializes at zero for a fresh consumer,
checks the owner epoch on every read, and advances by one retained event only
after the graph effect or a verified no-op. `readProjectionPublication` checks a
terminal outbox event against the settled pin and its exact source reference.

The integration test creates a disposable loopback PostgreSQL cluster under
`.temp/`, so it requires the pinned `initdb` and `pg_ctl` binaries. It does not
use or reset the developer Content database. Main/Access admission, graph adoption,
projection readiness, erasure and GC are integration work for later P0.8 slices.
