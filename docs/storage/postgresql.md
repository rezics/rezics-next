# Content and private PostgreSQL storage

The [Content schema](../../services/content/migrations/) and
[typed owner](../../services/content/src/core.ts) define exact serialized
revision bytes, parsed JSON, language variants, draft CAS, local receipts and
outbox. [Integration tests](../../services/content/tests/core.integration.test.ts)
exercise replay, concurrent heads, exact reads, pins and rollback. Account,
Access and operational tables have their own owners and migrations even when
they share a PostgreSQL process.

## Content records and exact revisions

Content retains exact serialized bytes because JSONB does not preserve the
original document's whitespace, key order or duplicate keys. The parsed JSONB
form serves structured reads; a digest covers the retained bytes. The
[Content read interface](../../services/content/src/core.ts) bounds exact batch
reads and reports unavailable or erased revisions without substitution.

## Publication preparation and retention

The [publication protocol](../contracts/commands.md#content-publication-and-delayed-visibility)
pins a prepared exact revision until graph outcome reconciliation proves a
terminal result. The [Content implementation](../../services/content/src/core.ts)
stores its preparation and settlement separately from the Jena adoption.

## Editorial protection binding

The [editorial protection contract](../contracts/editorial-protection.md#transaction-and-admission-protocol)
describes the required owner-local edit/protect lock and immutable correction
history. Its [acceptance scenarios](../testing/editorial-protection.md) remain
prospective where a profile is not yet qualified. A Content draft and a Jena
publication selection have separate heads and protection decisions.
