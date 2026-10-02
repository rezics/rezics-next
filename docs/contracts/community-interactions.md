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

Collection ordering and private favorites/progress remain separate interaction
profiles; each needs identity, disclosure and recovery contracts before its
presence in the product map can count as delivered.

## Follow, Join and notification

Maintainer, 2026-10-02. Three relationships, and never one word for two of them:

| Product term | Meaning | Target | Effect |
| --- | --- | --- | --- |
| Follow | One-way interest; free; the target need not accept (a person may refuse followers) | Any admitted resource or saved view: people and organizations, Spaces, Works, Concepts, Collections | Following feed, sidebar for Spaces, Continue strip, change feeds and a default notification level |
| Join | Membership with admission, rules, roles and bans | A Space with a Realm | Participation rights and member-only content; implies Follow |
| Notification level | All · Highlights · Off on each Follow or Join, plus Watch on single threads, proposals, releases and Collections | Those relationships | What reaches the inbox, push and email |

"Subscribe" is not a product verb: it means a free follow on YouTube and a paid
plan on X, Twitch and Patreon, and Reddit renamed its Subscribe to Join.
"Subscription" names only paid plans in billing; paid membership becomes a tier
of Join after the commerce gate. The split follows
[Schema.org](https://schema.org/JoinAction), where following polls for updates,
subscribing has them pushed and joining "does not imply that you'll be receiving
updates"; [XMPP publish-subscribe](https://xmpp.org/extensions/xep-0060.html),
which keeps affiliation apart from subscription; and
[Ren, Kraut and Kiesler 2007](https://experts.umn.edu/en/publications/applying-common-identity-and-bond-theory-to-design-of-online-comm/),
who found attachment to a group distinct from attachment to its members, which
is why a person is as followable as a community. API verbs use the
[ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-vocabulary/) names:
Follow, Join, Leave, Invite, Ignore and Block.

- **One follow record** per acting person and target. The target is any
  resource IRI or saved view, its kind read from the type registry rather than a
  closed list; a Realm and a Zone of one Space are one Space follow. Each record
  carries its notification level and source: explicit, join or library.
- **Join** admits the member and writes the follow in one server command.
  Leaving removes only a join-sourced follow. A member may hide the Space from
  Home without leaving.
- **Library.** Putting a Work on Reading or Plan to read follows it with source
  library at level All; taking it off removes only a library-sourced follow.
- **Saved views.** A Concept follow follows its one-Condition saved view
  ([queries](queries.md#concepts-and-value-pages)); any saved view can be
  followed.
- **Watch** overrides one thread, proposal, release or Collection at
  participating, all or ignore, and replaces the proposal-only subscription.
- **Reads** of follows and memberships are cursor-paged, searchable by name and
  ordered by recent activity or the person's pinned order. A person's follow
  count has a generous ceiling enforced as a budget, never as a page size.
- **Mute, Ignore and Block** stay separate negative relationships, offered in
  the same relationship menu.
- **Default levels**, hypotheses to measure rather than standards: Work All (new
  chapters and releases in the person's languages); person Highlights (new
  Works and announcements); Space Highlights (announcements and decisions;
  ordinary posts reach only the feed); Concept and saved view Off (a Home tab,
  optional digest). [Notifications](notifications.md#recipients-and-levels)
  owns delivery.

## Community completeness

Decision 20, product manager under maintainer delegation, 2026-09-29.
Reach Reddit-level task completeness through independent posts in any content
language, follow distinct from join, newcomer trust and budgets, moderation
cases with correspondence, rules per language, founder activation and reviewed
communities that can actually receive contributions. Private messaging remains
a deferred rollout despite the prospective conversation profile above.

The reason is a working community lifecycle, from first contribution to response
and appeal, rather than a collection of empty pages. [Discourse trust levels](https://blog.discourse.org/2018/06/understanding-discourse-trust-levels/)
offer a precedent for progressive participation; REZICS still needs calibration
and may not turn raw activity or multiple personas into authority.
