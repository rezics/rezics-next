# Discovery document format

This document owns the native discovery source format. Query authorization, current disclosure, candidate order and
shared analyzer requirements remain under [universal search conditions](../../../../docs/search-conditions.md).

## Canonical v1

All Discovery owners use one native v1 document and mapping. The mapping in
[`discovery.json`](../../db/search/indices/discovery.json) supplies tagged `_id` values of
`discovery-v1:<percent-encoded-kind>:<canonical-routable-uuid>` and an identical `_source.identity`.
Its constructor always includes precise calendar intervals and credited-name fields; physical generations
must be fully populated and reconciled before publication. There is no older writer or decoder selection.
The separate Subject-only index retains raw Subject UUIDs as its domain identity, not as a Discovery format.

Subject, Account and the second-scope kinds retain distinct exact field allowlists. Every owner shares the
identity, exact source-position and common public text fields. Subject dates retain their known components
and derived interval bounds; complete creator projections publish exact credited-name witnesses, while an
incomplete projection publishes no names. Second-scope owners carry their native revision and source-version
fields without gaining Subject facts or Account profile data. A Space carries its native Space or hosted Realm head UUID
in `source_version`. A legacy Space document with a null version binds current presentation only while its exact
indexed partition position is still current.

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

The canonical reader validates each owner's exact identity and allowed fields. Mapping metadata and the
expanded closed registry remain generation inputs: population, replay, reconciliation and continuing writes use
the complete canonical mapping, and publication follows complete current coverage. An old development index
requires a coordinated rebuild; its mapping or receipt cannot establish canonical coverage or a kind absent
from its registry. No live index is relabelled or upgraded in place by this contract.
