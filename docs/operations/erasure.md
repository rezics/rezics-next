# Erasure, retention and exact-history conflict

## Storage classes

Classify private credentials/control, user payloads, public semantic facts, source
evidence, derived indexes/caches, delivery metadata, audit and backups. Each class
declares purpose, disclosure, retention, applicable holds and a verified erasure
mechanism. Raw secrets/controller mappings never enter public immutable history.
Separate payload/key domains where this preserves the product/query contract.
Plaintext graph literals and indexes still need their own deletion coverage;
encryption at rest alone is not selective erasure.

## Operation states

`requested -> fenced -> inventory_complete -> deleting -> reconciling -> verified`.
A hold or unsupported storage operation is an explicit blocked state, not complete
erasure. Record authority, affected components, source/derivative dependencies and
a monotonically advancing erasure epoch. First stop new disclosure/activation,
then page controlled copies. Workers and restored sources check the frontier.

## Immutable graph handling

Fluree retraction removes current assertions while retaining history. Qualify the
selected build's purge/retention behavior across dictionaries, commits, old indexes,
replicas and raw captures. [Retraction semantics](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/transactions/retractions.md)
and [encryption boundaries](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/security/encryption.md)
establish why access suppression alone is not physical erasure.

Where selective purge is unavailable, implement controlled redaction/compaction
for the affected storage domain: fence writes, build sanitized retained state,
reconcile admissible changes, validate retained references, switch placement and
retire obsolete controlled copies under backup policy. This is a maintenance
operation, not an assumed built-in command or synchronous corpus rewrite per edit.
Coalesce requests and choose retention domains to bound its cost. Do not promise
that capability for a data class before its procedure is qualified.

## Exact references and backups

Erasure can supersede ordinary history pins. Affected RevisionRefs return erased/
unavailable; they cannot resolve to different content while claiming original
bytes. Retain only allowed non-sensitive tombstones/decision evidence. Unaffected
anchors use a verified retained representation/location; changed physical history
is not falsely presented as the same cryptographic artifact.

Backups declare expiry, holds, access and restore controls. Report their actual
retention until required copies expire or are sanitized/destroyed. Apply erasure
frontiers before user access or outbound replay. Previously delivered independent
copies/screenshots cannot be recalled by server deletion.

## Verification

Probe current/exact-history reads, matching/snippets/counts, payload delivery,
reimport, cached generations and isolated restore. Verify each inventoried class's
destruction or declared retention. An access-denied probe proves suppression only.
