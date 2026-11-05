# Native preparation header commitment

`preparation-bindings.ts` owns the pure `PreparationHeaderCommitment` shape and
`preparationHeaderCommitment(payload)`. Schema consumers, the native creator, the independent native reader and the
page runner must import this same helper. It returns lowercase SHA-256 hex over the RFC 8785 canonical JSON object,
including `version: 1`. It rejects missing or unknown fields at every level, non-JSON objects, accessors and hidden
properties rather than silently projecting them away. Property insertion order does not matter; string contents do.
No database, receipt, source-text read, Access check or native effect is performed here. The existing
[`typePreparationBinding`](type-preparation-contract.ts) behavior is unchanged.

## Consumer and SQL mapping

Build the explicit object below from the immutable `library.type_preparation_header` row. Do not pass a whole row or
an object spread of it: storage-only fields and mutable progress are deliberately outside the allowlist.

| Helper field                          | Native source / required representation                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                             | Literal number `1`; commitment format version, not a new public wire field                                                                             |
| `route`, `accountId`, `preparationId` | `route`, `account_id`, `preparation_id`; account and preparation UUID routes equal `route`                                                             |
| `binding`                             | `binding` JSON: exactly `accountId`, `subjectId`, `requestKey`, `sourceId`, `sourcePartition`, `sourceEpoch`, `sourcePosition`, `ownerEpoch`           |
| `origin`                              | `origin` JSON: exactly `sourceId`, `partition`, `epoch`, `position`, `survivorId`                                                                      |
| `sourceIdentity`, `originIdentity`    | `source_identity`, `origin_identity` JSON: each exactly `sourceId`, `partition`, `epoch`, `revision`, `transactionId`, `redirect`                      |
| `principalNamespace`                  | `principal_namespace` JSON: actual account `PrincipalCommandIdentity`, exactly `principal: {kind: 'account', id}` and `basis: {clientId, requestedBy}` |
| `reservationId`                       | `reservation_id`, canonical owner-routed UUID or explicit `null`                                                                                       |
| `inputByteLength`                     | `input_byte_length::text`, canonical nonnegative decimal                                                                                               |
| `inputDigest`                         | Native `input_digest` bytes32, `encode(input_digest, 'hex')` at this boundary                                                                          |
| `creationTransactionId`               | `creation_transaction_id::text`, canonical lowercase UUID of the creator's actual core command                                                         |
| `creationReceipt`                     | `creation_receipt` JSON: exactly `partition`, `principalKind: 'account'`, `principalId`, `commandKind`, `key`, `digest`                                |
| `createdAt`                           | `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, canonical UTC with six fractional digits                                    |

For the receipt locator, `partition`, `principalKind`, `principalId`, `commandKind`, `key` and `digest` map respectively
to `core.receipt.partition_no`, `principal_kind`, `principal_id`, `command_kind`, `idempotency_key` and
`encode(request_digest, 'hex')`. Its actual `transaction_id` must equal `creationTransactionId`. The owning partition
is `partitionOf(route)`, both principal IDs and `binding.accountId` equal `accountId`, and the creator kind is exactly
`library.type-preparation.create`. A receipt key has the existing core limit of 1–255 characters. The original
`binding.requestKey` is retained verbatim, separately from the native metadata receipt key.

Positions (`binding.sourcePosition`, `origin.position`), `binding.ownerEpoch` and byte length are strings matching
`0|[1-9][0-9]*`. Keep PostgreSQL bigint values as text or native bigint until decimal serialization; never pass through
`Number`, including values above 2^53. Identity epoch and revision are positive safe integers. A source UUID may be
remote; its encoded route must map to its recorded partition. Transaction UUIDs are canonical UUIDs, without an
owner-route requirement: core command transaction IDs are not account-routed IDs. The optional reservation UUID is
owner-routed. Hex digests must already be lowercase and exactly 64 characters; do not normalize caller data.

The origin source is the originally requested `binding.subjectId`. Its identity matches its source, partition, epoch
and survivor redirect. The resolved identity matches the binding source, partition and epoch and has no redirect.
For a one-hop merge, the origin survivor equals the resolved source, independently observed with its own stamp and
identity. Without a merge, origin and resolved stamps and identities agree exactly. Partition positions are observation
ordering, not item versions. Unrelated partition advancement does not change an identity's revision or transaction.
Capture both identities alongside the initial full type in the same authoritative repeatable-read observations;
later metadata revalidation compares fixed identities independently, without retransferring type text.

Do not round-trip `created_at` through a JavaScript `Date`: that loses microseconds. Format it in SQL before hashing,
and use the same text in creator and reader. The helper validates the UTC calendar representation without truncation.
Native bytes32 remain bytes natively and become hex only for this helper boundary. `binding_digest` is only a lookup
accelerator; `creation_commitment` stores this helper's result and is excluded from its own input. Mutable checkpoint,
state, ready type ID, enqueue flags, source text and input bytes are also excluded and rejected if supplied.

## Creator, reader and terminal evidence

The admitted native creator alone generates the initial text, digest, byte length and immutable byte copy from the
SAME accepted source input. It commits the entire immutable header and the actual core creator receipt response with
`metadataCommitment = preparationHeaderCommitment(header)` in ONE owner command. A root-ready response also binds its
actual published `typeId`; a pending response binds the retained `reservationId` association. Header hashing alone
neither proves exact input equality nor authenticates provenance. Exact retained reservation/value comparisons and
publication remain native, including digest collisions. Principal attribution includes the actual `clientId` and
`requestedBy` (string or explicit null); it is a namespace, never an authority or permission result.

Use deterministic internal receipt key namespaces `type-preparation:<preparation UUID>:create` for creation and
`type-preparation:<preparation UUID>:page:<chunk>:<byte offset>` for each bounded page, including the final page.
Chunk and byte offset use canonical nonnegative decimal strings from native bigint checkpoints; the native bigint
range keeps these keys within the existing 255-character core bound. Include the immutable binding (and hence source
and owner epochs), header commitment and exact checkpoint in the page receipt input, never full type text. A retry of
the same generation/checkpoint uses the same key and digest. A fresh admitted producer replaces cancelled or missing
work under the active-binding slot with a NEW preparation UUID, so old receipts cannot trap the new generation.

Before continuation or consumption, the independent reader must retrieve the actual core receipt and compare its
partition, account principal kind/ID, command kind, key, digest and transaction exactly against the native header,
then recompute the full header commitment and compare the actual receipt response's `metadataCommitment` too.
A stored or copied JSON locator/hash by itself is never authority. A terminal ready key must also equal the actual
root creator response's type ID or the actual committed final page response's type ID, with that page's matching
receipt namespace, digest, transaction and terminal checkpoint. Mutable `progress.type_id` alone cannot prove readiness.
The final page commits exact native publication, ready checkpoint and receipt together, before removing its reservation;
each intermediate page commits progress and its successor outbox together. Current source metadata, owner/gate and
ordinary user authorization checks remain the responsibility of the native consumers.

Core receipts need not be retained forever. Missing or collected evidence fails closed; a workflow never recreates
payload from metadata or restores a cancelled generation. Only a freshly admitted producer with fresh source/owner
observations can replace missing work under the slot and a new UUID. This adds no permanent receipt key, age-specific
wire format, public header or input cap. This helper's tests establish pure metadata behavior only, not successful
native creation, continuation, publication or product outcomes.

## Cost

Work touches bounded in-memory UUID/scalar/identity metadata plus original request-key/client attribution strings,
independent of source type length and dictionary population. It neither reads nor accepts whole type payloads.
Pure regressions cover exact decimals, microseconds, principal attribution, allowlist rejection and canonical hashing;
actual native readers own later statement/byte/population measurements.
