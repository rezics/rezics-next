# Private and operational PostgreSQL storage

## Responsibilities

Use PostgreSQL for Account credentials/session/protocol state, Access grants and
fences, and justified operational/accounting/install state. Each owner has private
credentials and migrations. Sharing a process does not permit another service to
read private tables as its API. Native semantic facts/revision metadata remain in TDB2, with immutable revision
payloads/manifests in object storage.

## Integrity

Use native types, NOT NULL, unique/exclusion constraints and concrete local FKs
for required invariants. A CHECK cannot prove facts in a remote service. Cross-store
Resource references have owner-verified registration and lifecycle/fence protocols.
SQL null semantics, uniqueness under concurrency and idempotency require rejected-
state tests. Keep public schema and snake_case physical names within each owned DB.

Atomic local commands write state, receipts and outbox together. Selective
subject/target/scope/expiry indexes support bounded reads and cleanup. Do not use
global table locks for unrelated accounts or one exact counter for all traffic.
Validate transaction isolation/retries instead of assuming application prechecks
are race-safe.

## Operations

Version migrations and engine/extensions; use disposable replay checks before
release. Backups include WAL/restore positions, role/configuration and secrets
references. Restore into isolation and reconcile cross-owner events/fences before
serving. Bound WAL retention and connector lag. A standby without a tested fencing
procedure is not safe automatic failover. See [recovery](../operations/recovery.md).
