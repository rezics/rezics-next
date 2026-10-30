# Minimal in-app notifications: owner-contract proposal

Proposed for Content/Web adoption; researched 2026-10-31. The recipient should discover a reply, mention or
moderation outcome, open its currently readable destination, and clear the indicator reliably.

## Decision and evidence

Amend [Content](../../services/kernel/src/content/README.md#notifications) to cover every first publication,
including opening posts; amend [Web](../../apps/web/README.md#notifications-inbox-inbox) to require working
destinations and recoverable seen updates. Preserve first-ten unique mentions, reply precedence before preferences,
no self-notices, mandatory moderation outcomes, send-time checks, display-time privacy, text-free storage, 180-day
retention and erasure. [Accounts](../../services/kernel/src/access/README.md#viewer-preferences) remains preference
authority. No email, push, feed or wider fanout.

Discourse checks inbox authority and current topic accessibility before serialization; it distinguishes seen state
from individual read actions ([controller](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/notifications_controller.rb),
[model](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/notification.rb#L249)).
Source read from main checkout `.reference/partitioned-sitemap-feeds/discourse`: those files and
`app/serializers/notification_serializer.rb`; GPL-2.0-or-later (`README.md`, `LICENSE.txt`). Mastodon separates delivery
dropping from presentation filtering, caps [unread counts](https://docs.joinmastodon.org/methods/notifications/), and
persists a [notification marker](https://docs.joinmastodon.org/methods/markers/); its
[content filters](https://docs.joinmastodon.org/entities/Filter/#context) also apply in notifications. Documentation:
[GFDL 1.3](https://github.com/mastodon/documentation/blob/main/LICENSE).

Shared pattern: recipient-owned activity, an explicit position and current presentation policy. Keep REZICS's
forward-only marker instead of adding per-item read/dismiss state. Opening the first ready page acknowledges
through its newest returned notice, not that every target was opened. Count remains retained unread notices, so a
positive badge can accompany a filtered page. Prefer bounded continuation over scanning to fill a page. Mandatory
decisions remain readable independently of removed content. No adopted policy conflict was found. The earlier
[review](content-done-when-review.md) supplies context, not proof of this journey.

## Actual journey and gaps

Paths use `C = services/kernel/src/content/`, `W = apps/web/src/`.

1. **Author/replier:** `W/routes/boards/$id_.new.tsx` (`NewThreadPage`) and `W/routes/threads/$id_.$slug.tsx`
   (`ThreadPage`/`PostComposer`) call `threads/actions.ts`/`post-writes.ts`: existing thread/post POSTs carry the
   document, licence, subject metadata and stable structured-string command key. `C/routes.ts`/`commands.ts` use
   `runCommand`, return thread/post/revision identities, and commit content plus events on the thread route.
   `C/register.ts`/`relays.ts` install reply/mention effects in `services/kernel/src/events/effects.ts`'s durable
   runner. They consume `com.rezics.content.post.created.v1`, call real `notificationAllowed` and
   `postReadableByAccount`, then write the recipient route. Successful denial stays denied on replay. **Gaps:**
   opening posts emit `thread.created.v1`, which mentions do not consume; draft publication has no transition in
   `C/model.ts`, `routes.ts` or `commands.ts`. Revision writes only advance the head.
2. **Moderator/author/reporter:** `W/routes/boards/$id_.moderation.tsx` and `W/moderation/actions.ts` submit existing
   takedown, dismissal and appeal-resolution actions. Registered effects in `C/moderation-decisions.ts`,
   `report-outcomes.ts` and `appeals.ts` send mandatory author/reporter/appellant notices. Decisions/reports/appeals
   retain authority in their Content source partitions. `W/routes/moderation/decisions.$id.tsx` → `DecisionPageView`
   uses existing decision/appeal APIs to show reasons, deadline and resolution despite a withheld target.
3. **Storage/inbox/settings:** `services/kernel/db/content/migrations/20261027200027_content_notice.sql` owns
   `content.notice`/`notice_seen` on recipient routes, unique by recipient/kind/source, without text. `C/notices.ts`,
   `work.ts` and `erasure-workflow.ts` own bounded retention/cleanup. `W/shell/shell.tsx`/`UnreadBadge` opens `/inbox`
   (`W/routes/inbox.tsx`, `InboxPageView`). `W/inbox/inbox-read.ts` uses the current credential for existing
   `/v1/accounts/{accountId}/notifications`, `/count` and `:markSeen`; `C/notice-routes.ts` rejects other accounts
   with 404. DTOs carry identity, kind, time, actor/target IDs and unread state. `C/notice-inbox.ts` filters current
   post access and seals viewer-bound continuation with bounded scans. Web rereads distinct post/decision/report
   targets and actor identities; withheld targets have no text/link. `/settings#notifications` uses Accounts
   preferences GET/PATCH, expected version and command key; mandatory kinds have no toggle.
4. **Final result:** opening sends `{ through }` to mark seen; the handler validates the key and advances one
   marker, without a command-receipt replay. **Gaps:** Web sends an unquoted UUID and records its attempt before
   success, without recovery. Post links use `#<id>`, while `ThreadPage` renders `post-<id>` on a paginated list.
   Report links name `/moderation/reports/<id>`, which has no frontend route. Stories/fakes show presentation,
   not served integration.

## Product deltas for existing owners

Adopt these changes in the linked owner contracts; fold them into existing authoring/inbox assignments, with one
writer per module. Do not duplicate preferences, mention editing, inbox scaffolding or moderation workflows.

- **First publication reaches its mentioned reader — Content:** extend `C/mention-notices.ts` to the actual
  published opening event. Attach draft creation/publication to the existing authoring work in `model.ts`,
  `schemas.ts`, `routes.ts`, `commands.ts` and the event contract; Content defines wire/source detail there, without
  this report inventing an endpoint/event. Dependencies: committed first published revision and existing
  Accounts/Access ports. Reuse frozen notification outcomes: opening mentions once; draft publication uses that
  revision's first ten unique mentions, while later revisions/replay add none.
- **Reply/mention opens the selected post — Web:** change `W/inbox/inbox-read.ts`, `W/threads/thread-href.ts` and
  both thread routes. Preserve `post-<id>` through canonical redirects; if absent from the loaded page, render the
  selected post through existing `GET /v1/posts/{id}`, without walking pages. Dependency: current item disclosure.
  Two outcomes: a later-page post is visible after following its notice; revocation before landing reveals no stale
  text.
- **Reporter opens their outcome — Web:** add `W/routes/moderation/reports.$id.tsx` and its reader/view under
  `W/moderation/`, using existing `GET /v1/reports/{id}` (`C/report-routes.ts`/`schemas.ts`). Show outcome independently
  of target readability, limited to that DTO. Two outcomes: reporter opens actioned/dismissed outcome; unrelated
  viewer gets absence.
- **Opening reliably clears the indicator — Web:** fix `W/inbox/inbox-read.ts`/`inbox-page.tsx`: serialize and retain
  one valid key per through-marker attempt, acknowledge success after 204, offer retry on failure, then refresh
  count/unread presentation. The raw UUID violates [RFC 8941 §3.3.3](https://www.rfc-editor.org/rfc/rfc8941.html#section-3.3.3)
  (IETF Trust/BCP 78) and `services/kernel/src/http/request.ts`. Two outcomes: opening updates the real marker/count;
  retry succeeds without marking a later arrival seen. Keep monotonic backend semantics.

Keep patches at least 60% product changes, with only these focused outcomes in existing suites and no new harness.
Accounts retains preferences, account identity and lifecycle authority;
[Semantic](../../services/kernel/src/semantic/README.md) retains semantic identity/Context authority, requiring no
new port. [Search](../../services/kernel/src/search/README.md) consumes existing public content projections;
private notices, preferences and moderation text never enter its index.
