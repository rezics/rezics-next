# Community interactions and messaging

## Discussion, polls and curation

Threads identify topics/origins and reply placements; Posts retain utterance/content
identity and exact targets. Promotion/reparenting creates explicit layout changes
without rewriting who replied to what. Removing a root does not delete other
authors' content. Multi-Realm publication has independent acceptance/revisions.

Polls identify question/option meaning, population, voting method, close policy and
private counting identity. Changes after voting cannot reinterpret existing ballots.
Collections store identified ordered memberships; favorites and reading progress
can remain private even when their target is public. Follow subscriptions identify
the followed subject and delivery intent without granting access to private activity.

## Conversation and message model

Conversations have membership/admission generations, eligible history intervals,
message identities, exact edits, attachments and explicit retention. Native durable
message facts use TDB2 and immutable application revisions; secret payloads
and ephemeral delivery/presence use their appropriate private/object stores.
Assess erasure and encrypted-payload profiles independently before claiming those
capabilities. Conversation existence never makes every historical message readable.

Route message history by conversation and bounded time/size buckets; many small
buckets can share a dataset. Edit routes to the original message, not today's bucket.
Hot lanes require an explicit merge/order contract; strict conversation ordering
retains its serialization cost. Realtime sequence and delivery receipt are not
the same as the dataset sequence.

## Operations and implementation

Create/reply/edit/reparent/close, vote/withdraw, curate/reorder, follow/unfollow,
favorite/progress and send/edit/retract commands share authority, CAS and receipts.
Private blocks/preferences and recipient read watermarks have dedicated ownership.
Transport is recoverable; typing/presence expire and do not generate permanent
semantic history. Distributions/counters/inverses are bounded projections.

Test root deletion, repeated collection targets, private counts, rejoin history,
persona voting, message reorder/reconnect, retract/erase, stale attachments and
delivery replay. See [notifications](notifications.md) and [Realm delivery](realm-delivery.md).
