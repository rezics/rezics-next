# Discovery document format

This document owns the native discovery source format. Query authorization, current disclosure, candidate order and
shared analyzer requirements remain under [universal search conditions](../../../../docs/search-conditions.md).

## Compatibility

Format 1 remains the immutable legacy Subject/Account source shape and mapping. Its UUID-only receipt and parser
semantics do not change. Format 2 is the `mixed-public-v1` source shape: it uses the strict shared mapping in
[`discovery-mixed-v1.json`](../../db/search/indices/discovery-mixed-v1.json), tagged `_id` values of
`discovery-v1:<percent-encoded-kind>:<canonical-routable-uuid>`, and an identical `_source.identity`.

**Decision:** format 2 remains the sole mixed public wire format; the three second-scope kinds use its existing
common public text and native revision fields, and a generation may publish them only with the expanded registry
and matching mapping receipt.

Format 2 is additive by owner and kind. Subject and Account retain their existing exact field allowlists and
validation. The second-scope kinds use only the common identity fields plus `revision`, `names`, `descriptions` and
`name_sort`; a new kind never widens the Subject or Account allowlist. Format 1 rejects all second-scope kinds.

## Second-scope identities and public fields

| Kind         | Owner      | Identity                                                                              | Indexed public metadata                                                                                                                                |
| ------------ | ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collection` | `commerce` | The Collection UUID and route                                                         | The public Collection title in `names`; no description, curator, member count, saved predicate or member fact.                                         |
| `review`     | `content`  | The review thread UUID and route; `kind: "review"` preserves its thread discriminator | Only text the Content adapter has already approved for public review discovery. A current author vote or vote citation is never copied into the index. |
| `space`      | `content`  | One Space UUID and route, regardless of its hosted Realm or boards                    | The current public Space title and summary, represented in `names` and `descriptions`.                                                                 |

The owner and kind are a closed pair. A source key always contains owner, kind, route and canonical UUID; that full
key survives tagged identity creation, document validation and hit decoding. Each leaf adapter decides current
eligibility and translates its approved metadata into the common fields. Search does not infer visibility, expand a
Collection predicate, copy private Collection facts, or read a review vote.

The local codec seam accepts a complete snapshot with one exact native `bigint` position and complete full keys.
Every indexed row has an exact native `bigint` revision. The codec writes both as canonical decimal strings and
rejects floating point versions, incomplete snapshots, wrong owners or routes, duplicate or unrequested rows,
unknown fields and malformed tagged IDs before returning actions. Missing rows mean deletion only when the adapter
marks the requested keyset complete. Validation work is bounded by the requested keys and returned rows (up to 256
keys per observation); runtime measurement remains pending.

## Mapping and generation handoff

All kinds use the existing `cjk_bigram_v2` analyzer and shared `names`, `descriptions` and `name_sort` fields. The
mapping remains `dynamic: "strict"`; its `second_scope_kinds` metadata binds Collection to Commerce and review and
Space to Content. No per-kind engine, index or client is introduced.

Format 1 readers retain their existing meaning. Format 2 readers continue to decode existing Subject and Account
documents as before and decode a second-scope document only when its owner/kind pair and allowlisted fields match.
The mapping metadata and expanded closed registry are generation inputs: the generation owner must build and relay
the complete common projection, and publish only after its current registry and mapping receipts match. An old
generation or receipt cannot establish coverage for a kind absent from its registry. This document does not assign
the leaf adapters or generation relay to Search's document codec.
