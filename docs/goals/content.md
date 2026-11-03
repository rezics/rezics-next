# Content and communities

## Outcome

People can participate in communities, publish and discuss content, rate and review subjects, and receive relevant
in-app notices. Moderators can resolve reports, pin board threads, and enforce visibility and erasure across owned
resources.

## Done when

- Threads, posts, replies, revisions, board listings and persistent board pins work through real APIs for readers,
  authors and moderators. Pins never grant visibility, and active, hot and newest continuation skips pinned threads
  without losing sparse-page progress.
  Canonical document bodies, licences, references and media claims follow their owner contracts.
- Media reservation, upload completion, image derivatives, downloads and bounded abandoned-object collection preserve
  uploader identity and current disclosure across the kernel and site Worker.
- Spaces and Realms support membership, roles, bans, boards, slow mode, watch, Context behavior and publication
  without granting global ownership. Bans deny protected reads immediately during removal work.
- Reactions, board ranking, Realm rating sorts, subject ratings and reviews provide only permitted aggregates with
  declared freshness.
  Search can consume the safe public rating aggregate without exposing private Realm figures.
- Public Collection, review and Space discovery, plus a moderator workbench for reports and owned resources, follow
  their current disclosure and moderation contracts.
- Reports, moderator resolution and minimal appeals work across owners; takedown, erasure and exact references
  preserve current disclosure and the retained lifecycle evidence.
- Minimal in-app reply, mention and moderation notifications honor preferences and send-time access.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes content, media, community resources, publication, reactions, ratings/reviews, Realm rating sorts, moderation,
slow mode, watch, public Collection/review/Space discovery and minimal in-app notices. Articles and hosted works
remain closed behind grants until polished. Email notifications and account mute/block remain deferred under
[public scope](../scope.md). Web owns editors and media transport; accounts owns membership authority and preferences.

## Ownership

Owns `services/kernel/{src,db,test}/content/**`, `services/kernel/{src,db,test}/community/**` and
`services/kernel/{src,db,test}/rating/**`.
[Content](../../services/kernel/src/content/README.md),
[community](../../services/kernel/src/community/README.md),
[rating](../../services/kernel/src/rating/README.md) and [deletion](../deletion.md) own behavior.
The [document package](../../packages/document/README.md) is owned by web; agree its content boundary jointly.
Shared erasure, notification and publication consumers stay with the owner of their data.

## Dependencies

Requires Access creation grants, membership and ban workflows, semantic subjects and Contexts, common follows,
registered kernel events and durable work. Web supplies uploader-bound transport and authenticated pages. Search
consumes the public rating projection; accounts supplies notification preference and lifecycle ports.

## Acceptance

Use [thread outcomes](../../specs/content-thread-outcomes.test.ts),
[disclosure outcomes](../../specs/content-disclosure-outcomes.test.ts),
[media outcomes](../../specs/content-media-outcomes.test.ts),
[notification outcomes](../../specs/content-notification-outcomes.test.ts),
[community outcomes](../../specs/community-outcomes.test.ts), and native content/community/rating tests.
Cover anonymous, author, member, moderator, banned, suspended and protected non-member personas. Exercise the real
HTTP/API, relays and default-worker completion where required; native units alone do not prove the whole workflow.
Use the owning kernel check runner and [verification](../development/verification.md) for growth and promotion.

## External conditions

Object storage, image delivery and production moderation operations require configured services. Repository
acceptance proves lifecycle and disclosure with isolated resources; private operational setup is external.
