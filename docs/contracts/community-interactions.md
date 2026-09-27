# Community interactions and messaging

The current [reply owner](../../services/main/src/modules/realm-reply/schema.ts)
retains exact reply origin, parent and revision identity with independent Realm
review. The [vote owner](../../services/main/src/modules/vote/schema.ts) defines
the implemented governance poll and private counting admission.

Thread promotion or reparenting still needs an explicit layout revision that
preserves original reply targets. Removing a root must retain other authors'
posts. These are separate from the reply identity already stored.

## Conversation profile to implement

A conversation needs membership and admission generations, eligible history
intervals, message identities, exact edits and attachments, and explicit
retention. Existence of a conversation cannot grant every member all past
messages. Assess erasure and encrypted payloads as separate profiles. Route
history through bounded time/size buckets; edits must resolve the original
message. Hot lanes need a merge/order policy, and realtime delivery receipts
must not be confused with persistent message sequence.

Sending, editing, retracting, read watermarks and temporary presence need
separate authority, replay and disclosure tests, including rejoin history,
reorder/reconnect, stale attachments and erasure. The
[notification contract](notifications.md) and [Realm delivery](realm-delivery.md)
do not supply a general conversation service.

Collection ordering, private favorites/progress and follow subscriptions remain
separate interaction profiles; each needs identity, disclosure and recovery
contracts before its presence in the product map can count as delivered.
