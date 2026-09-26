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

## Editorial protection binding

[Editorial protection](../contracts/editorial-protection.md) follows the mutable
head's owner. Protection of a Content draft head is local to PostgreSQL; protection
of a Jena publication selection is checked at graph adoption. Saving a new Content
candidate does not replace that protected selection and need not be prohibited.
The generic protection schema/procedures below are required target extensions;
existing revision guards do not establish them.

The owner binding needs a stable component row, nullable protection/control head
references with declared absence semantics, append-only protection/control and
correction-decision history, and a unique correction application per proposal
revision. Use local FKs to retain target, predecessor and exact revision identity;
index current target/context heads, proposal/decision lookups, application identity
and bounded history ordering. Reuse the component's existing receipt/outbox and
revision tables where their semantics fit; do not add a general lock database.

Both edit and protect/relax operations acquire the same existing component row
lock before reading eligibility and performing CAS. Locking only an optional
protection row fails when that row does not yet exist. A create-only component
uses its native unique key and transaction protocol. A multi-component profile
must bound the set and lock it in canonical order; the initial profile is one
target. All expected heads, control epochs, rule/approval references and exact
candidate digests are checked in this transaction.

Immutable history rejects both UPDATE and DELETE through owner constraints and
mutation guards; ordinary credentials cannot bypass the owning procedures.
An explicit erasure procedure has its own admitted scope and permitted columns,
preserves non-retargetable anchors and propagates tombstones to retention/recovery.
These are application/ordinary-writer guarantees, not tamper-proofing against a
database superuser. Protect schema/trigger administration separately.

Approval plus bounded application commits new content/acceptance, the decision,
one-use application, head, receipt and outbox together. A failed CAS leaves no
partial adoption; retries resolve the recorded operation. Remote approval or
source references require exact prepared evidence and the declared fence, not
a supposed cross-store FK. A PostgreSQL transaction and later Jena activation
remain separate under [publication preparation](#publication-preparation-and-retention).

Use [row-lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
and verify missing-protection, edit/protect races, deadlock/retry and restore
cases in the [protection matrix](../testing/editorial-protection.md). Keyed lookups
and a bounded result set do not by themselves prove the physical query cost.

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
