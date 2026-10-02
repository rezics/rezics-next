# Notifications

## Recipients and levels

Maintainer, 2026-10-02. A recipient comes from three sources, in this order:

1. **Direct involvement**: replies and mentions, the person's own submissions
   and proposals, role and membership changes, invitations and moderation they
   are party to. Always delivered to the inbox; only blocks, mutes and channel
   preferences change it.
2. **Relationships**: each Follow or Join at its notification level
   ([interactions](community-interactions.md#follow-join-and-notification)).
   Highlights covers announcements, decisions, new Works and new releases; All
   adds every post or chapter; Off adds nothing beyond direct involvement.
3. **Watch** overrides on single threads, proposals, releases and Collections.

The level decides which targets notify; the existing per-topic and per-channel
preferences decide how (inbox, push, email digest). Delivery rechecks
disclosure and the follow's state, so a follow paused by a private Space
delivers nothing. Optional email keeps one-click unsubscribe
([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html)).

## Channels still pending

The [notification owner](../../services/main/src/modules/notification/README.md)
implements recipient intents, inbox/read state, push delivery, current disclosure
checks and uncertain provider reconciliation. Account security/recovery mail is a
separate purpose and [operator rollout](../operations/deployment.md#email-rollout)
selects its sender.

Before optional email rollout, add an Account-verified address resolver, signed
preference/unsubscribe links with expiry and one-click subscription handling, and
provider suppression/complaint integration. Private preferences, blocks and muted
topics must apply to optional delivery; a source user or provider aggregate must
not create a native recipient.

Before webhook rollout, bind deliveries to installation scope and signed envelopes.
Keep addresses and tokens outside public RDF. If presence or typing is introduced,
give it expiry rather than permanent graph history. Qualify each new channel with
recipient changes, invalid endpoints, unsubscribe, disclosure loss, lost ACK and
restore before enabling it.
