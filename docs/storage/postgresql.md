# Content, private and operational PostgreSQL storage

## Responsibilities

PostgreSQL is the authoritative store for Content bodies, revisions and drafts,
reader preferences, Account credentials/session/protocol state, Access grants and
fences, and operational/accounting/install state. Separate roles, migrations and
owner interfaces apply even within one cluster. Content belongs to Main; accessing
its module need not introduce another network service. Semantic facts, names,
predicate definitions/labels, relation history and adoption remain Jena-owned.

## Content records and exact revisions

The initial Content binding stores bounded document JSON and immutable revision
metadata/manifests in PostgreSQL. Retain component/variant ID, revision ID,
predecessor, operation, format/model version, language/direction, source revision,
digest and availability/erasure state. Draft head CAS, committed revision,
operation receipt and outbox event share one local transaction. Published adoption
is a graph decision referencing that revision, not a second mutable Content head.

Use JSONB for structured reads and versioned serialized bytes for exact revision
integrity when required by the common history profile. JSONB does not retain
whitespace, object key order or duplicate keys: never hash an assumed original
document by reserializing JSONB. The initial SHA-256 profile hashes the retained
serialized bytes; JSONB is a derived parsed representation of those same bytes.
Large payloads may use sealed object pages under a retained manifest with explicit
size limits; ordinary bounded bodies do not require an extra object-store read.
Source: [PostgreSQL JSON types](https://www.postgresql.org/docs/18/datatype-json.html).

Store native language variants as identified records, allowing multiple variants
in one language. Preserve provenance and exact source-version references. The
[language contract](../contracts/content-languages.md) governs preference,
fallback and separately published translations. PostgreSQL language metadata is
mirrored for graph/search joins by immutable revision identity, never independently
edited in both stores.

Exact revision batch reads have fixed item and byte ceilings and return per-item
availability after current authorization. Do not silently replace a missing
revision with the latest body or divide an unbounded result into extra SQL calls.
Index component/head lookups, revision IDs, durable outbox progress and pin/GC
state. SQL stays in owner adapters; domain code uses bounded typed operations.

## Publication preparation and retention

Preparing publication durably pins a committed revision for an identified
operation and returns its owner/revision/digest/format reference. Graph activation
records that exact dependency and an owner-local outcome. The Content worker
settles the preparation from that outcome; a lost response remains pinned until
reconciliation proves terminal success or failure. A timer or stale graph read
alone cannot release the pin. The graph transaction performs no PostgreSQL I/O.

Search consumes exact retained revisions and current semantic selection through
[the projection contract](../contracts/search.md#postgresql-body-projection).
Content GC considers retained history, graph publication/release pins, unresolved
preparations and erasure policy through a fenced reconciliation generation. An
explicit erasure may invalidate an exact reference; its outcome is erased or
unavailable, not substituted content. This is a target protocol, pending P0.8.

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
