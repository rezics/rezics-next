# Moderation: finish the report-to-appeal journey

Proposed changes for the [Content contract][content] and [Web page contract][web], researched 2026-10-31:
make reports discoverable by moderators and trackable by their reporters, then carry authors through one independent
appeal to a visible result. Preserve existing authority, private evidence and minimal appeals.

## Primary evidence and tradeoffs

- Discourse puts flags into a review queue and offers separate report judgments and content actions. Its
  [official content-moderation guide](https://meta.discourse.org/t/discourse-moderation-guide-part-3-managing-content/406266)
  and [ReviewableFlaggedPost.build_combined_actions](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/models/reviewable_flagged_post.rb#L61)
  support a discoverable queue with context-sensitive actions. Adopt that pattern without automated flag-score
  takedowns, penalties or moderator chat.
- Lemmy separates the reported original from current content: [PostReport](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_schema/src/source/post_report.rs)
  stores original fields, [create_post_report](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/api/api/src/reports/post_report/create.rs)
  captures them, and [ReportCombinedViewInternal](https://github.com/LemmyNet/lemmy/blob/1cc23de9ec0baf13dc4f02c47f6722985c0c60d3/crates/db_views/report_combined/src/lib.rs)
  includes current content. Use REZICS's revision references and ordinary reads for this distinction; body copies
  would create another disclosure and erasure obligation.
- Reddit's [official appeals description](https://support.reddithelp.com/hc/en-us/articles/23511059871252-Content-Moderation-Enforcement-and-Appeals)
  connects removal reasons, appeal instructions and reversal. The shared pattern is context, an understandable
  decision and a visible outcome. Keep REZICS's 183-day clock and independent reviewer, not Reddit's calendar-month
  wording or broader enforcement system.

References are retained under the main checkout's `.reference/partitioned-sitemap-feeds/discourse/` (reused;
GPL-2.0-or-later, `README.md`/`LICENSE.txt`) and `.reference/content-moderation-appeals/lemmy/` (shallow;
AGPL v3; `Cargo.toml`: `AGPL-3.0`, `LICENSE`). Source links pin inspected revisions. Recommend designs, not code copies.

## Current journey and missing behavior

All Web paths below are under `apps/web/src/`. Kernel command routes require `Idempotency-Key`; wire schemas remain
owned by [Content][content] and its linked route modules. Keep current command authorization before receipt replay.

1. **Reader reports.** `routes/threads/$id_.$slug.tsx` mounts `PostActions` from
   [report/content-actions.tsx][report-ui], opening `packages/ui/src/components/report-dialog.tsx`.
   `report/actions.ts` → `report/submit.server.ts` calls `POST /v1/reports` with target, optional revision, reason and
   evidence; 201 returns `{ reportId }`. The dialog keeps one UUID per intent; anonymous retries need fresh proof.
   [reports.ts][reports] commits `content.report` in a principal/command/key-derived home, not the target or reporter
   account route; it stores references and submitted evidence, not a body snapshot. `report.created` drives
   [report-effect.ts][projection] into target-route `content.report_target`. **Gap:** Web discards the successful ID.
2. **Reporter follows up; moderator discovers.** `/inbox` uses `InboxPageView` and
   [inbox-read.ts][inbox] to resolve report outcomes through `GET /v1/reports/{id}`, then links to
   `/moderation/reports/{id}`. **Both steps are missing for ordinary reporters:** that page route does not exist,
   and `readReport` requires target `moderation:read_reports`, even for the submitter.
   `/boards/{id}/moderation` mounts `ModerationReportsView`; `loadModerationReports` selects existing board/thread/post
   `GET /v1/{boards|threads|posts}/{id}/reports` and one ordinary read per distinct target. **Discovery gap:** board
   lists contain reports targeting the board itself, not its threads/posts; filters require an already-known ID.
   Rows contain evidence and `revisionId`, but the page reads only current content. Withheld exact reads
   remain 404; report-inspection authority does not grant body access.
3. **Moderator decides.** [actions.ts][actions] calls the actual board/thread/post `:takeDown` route with `{ reason }`
   (200 `{ securityRevision }`), or `POST /v1/reports/{id}:dismiss` (200 report ID and `dismissed`).
   [moderation.ts][moderation] → `erase-post.ts` commits visibility, security revision, `content.moderation_decision`
   and an ID-only event in the target partition. [report-outcomes.ts][outcomes] resolves open reports in pages of
   at most 100 across their source partitions; dismissed outcomes stay final. Recipient-route `content.notice`
   delivery is separate and deduplicated. **Gap:** Web concatenates two fields allowing 2,048 characters each into
   a native reason limited to 1,024; it also generates fresh command keys on every server-function invocation.
4. **Author appeals.** An inbox decision link, or `threads/post-removed.tsx`'s author-only `decisionId`, reaches
   `/moderation/decisions/{id}` → `DecisionPageView`/`readDecisionPage`. `GET /v1/moderation-decisions/{id}` returns
   the statement, deadline and appeal state independently of target visibility. [appeal.ts][appeal-ui] calls
   `POST /v1/moderation-decisions/{id}:appeal`, `{ statement }`, receiving 201 `{ id }`.
   [appeals.ts][appeals] stores `content.moderation_appeal` with its decision/target on the target route: author only,
   once, 1–2,000 characters, deadline inclusive; unrelated decision reads/appeal attempts are 404, duplicate appeal 409,
   first late appeal 422. Web already renders pending/expired/resolved states; it need not be rebuilt.
5. **Independent review and visible result.** The same board page's `tab=appeals` mounts `ModerationAppealsView`.
   Existing `GET /v1/boards/{id}/appeals` and `/v1/threads/{id}/appeals` return pending appeal/decision statements,
   target and `canResolve`. Board candidates live in `content.moderation_appeal_board`, projected asynchronously
   from committed appeal events; each source is independently reauthorized. `actionOnAppeal` calls
   `POST /v1/moderation-appeals/{id}:resolve`, `{ outcome: uphold|reverse, statement }`, returning 200 `{ id }`.
   Resolution stores `upheld|reversed`; reversal invokes `lift-takedown.ts` in that transaction, increments security
   revision and emits `moderation.restored`. Effects remove the pending candidate and notify the appellant, whose
   decision page displays the final statement. **Gap:** reviewer success immediately reloads a pending-only queue,
   losing confirmation; appeal/resolution retries also receive fresh keys. These are real route bindings,
   but [kernel/client.ts][client] falls back to a fake kernel in development without `KERNEL_ORIGIN`; stories are
   not served integration evidence.

## Private Appeals reads and recovery

The default board moderation route's Appeals tab reads one existing board or thread Appeals page through the
generated KernelClient, with `limit=20` and the native opaque signed cursor unchanged. A post report scope is return
context: the page explicitly names the containing thread scope when supplied, or the board scope otherwise. It never
claims a post-only Appeals list, postfilters a page or calls a post Appeals endpoint. Returning to Reports preserves
its scope and selection metadata. Ordinary target reads remain deduplicated and use the existing enrichment; withheld
targets do not suppress independently authorized appeal and decision statements or grant content access.

Every private response binds the prepared session's viewer, board/thread/post return context, cursor and a fresh read
generation. Session preparation and credential reads remain private/no-store; a missing prepared viewer closes the
read without anonymous fallback. The route also binds the response to the navigation that requested it and discards
aborted loaders. The mounted page retires its private statements, target evidence and resolution forms immediately
on viewer loss/change, browser-session replacement (including a new CSRF token for the same signed-in account),
unknown session after a known session, scope/cursor navigation or departure. Initial unknown browser state preserves
prepared SSR until the first known session establishes the browser identity. Session identity is compared only in
the mounted lifetime's memory; it is never logged, persisted or added to read/cache keys. Retirement is independent
of target readability and irreversible for that mounted generation, even if the former session, viewer or URL
returns. Late retry success or failure cannot revive it. Fixtures without page identity remain compatible with
presentation stories and never supply production authority.

Loading, terminal empty, sparse empty with a native next cursor, recoverable unavailable, stale-cursor restart and
closed access are distinct. A loaded page, including a terminal empty page, offers explicit refresh of its exact
admitted input; unavailable retry repeats that same read. Both clear old private content first and never replay a
resolution or invalidate Reports.
Refresh waits while any resolution is sending or uncertain, retaining its mounted command owner and exact retry until settlement.
Each click reads one bounded native page and its deduplicated targets; the original private reader admits the response
and its actual native generation. Invalid/expired native cursors offer an explicit first-page restart
that removes only the Appeals cursor. Unknown and not-visible scopes share the same closed message. Native problem
details never enter the UI. List `canResolve` remains the current native hint; commands still authorize independently,
including the original-reviewer prohibition. Successful resolution confirmation stays visible until navigation or
deliberate queue refresh.

## Amendments to adopt and product slices

1. **A moderator can find and resolve a reader's post report. Content backend + Web.** Amend Content's board-list
   contract to include descendant thread/post candidates. Extend the existing `report.created` projection using
   native post→thread and `thread.board_id` reads into a board-local candidate index; retain exact thread/post lists.
   Admit at most `limit + 1` candidates, independently check current target report authority and board membership,
   and advance past denied/stale candidates; no descendant scan or authority inherited from queue membership.
   Change [reports.ts][reports], [report-effect.ts][projection], `services/kernel/src/content/page-target-reports.sql`,
   `services/kernel/db/content/schema.sql`, `moderation/reports-read.ts` and `moderation/reports-page.tsx`.
   Label submitted evidence, reported revision and current target separately; use existing
   `GET /v1/posts/{id}/revisions/{revisionId}` only when the post identity is known, otherwise state unavailable.
   Use one reason field within the native 1,024-character limit. Dependencies: existing target ancestry, Access,
   outbox relay. Focused outcomes: a post report appears on its board and disappears on authority loss; an edited
   target shows the readable reported revision separately and submits a valid takedown reason.
2. **A reporter can reopen their report and see pending/actioned/dismissed. Content backend + Web.** Add the already
   specified self-report branch to the existing report GET and its closed DTO (`report-routes.ts`, `reports.ts`,
   `schemas.ts` under `services/kernel/src/content/`). Its DTO exposes only report identity/status/times, alongside
   the existing authorized moderator branch. Check current account standing and stored reporter ownership;
   failed self-ownership checks return 404. Anonymous submission confers no lookup capability. Retain the successful
   ID in `PostActions` and implement
   the currently missing inbox destination under `routes/moderation/`; update [inbox-read.ts][inbox]. Dependencies:
   existing report storage/outcomes and Accounts checks, not the async reporter locator. One focused outcome:
   reporter follows receipt and notice to the same status while another account cannot read it, including after
   target takedown. Label `actioned` as the report's disposition; an appeal does not rewrite it.
3. **An author and independent reviewer finish one appeal reliably. Web; Content for agreed denial mapping.**
   Amend the page contract to keep one command UUID for each unchanged appeal, resolution or report action across
   uncertain-response retries; preserve the author's existing conflict reread. Change [appeal.ts][appeal-ui],
   [actions.ts][actions], `moderation/decision-page.tsx` and `moderation/appeals-tab.tsx`; show the confirmed reviewer
   result before removing its pending row. Retain original-decider 403 and unknown-appeal 404. The existing native
   appeal/notification cases already own deadline, single-appeal, reversal and notices; add only a lost-response
   retry outcome and a reviewer confirmation outcome beside the existing Web cases. No replacement driver or harness.

These amend the existing [moderation capability][capability]; its pending frozen-suite binding remains existing work.
Implement UI/API/storage behavior first; keep product changes at least 60% of changed source, without padding.

Keep the minimum 183-day evidence retention and inclusive appeal deadline. [Deletion][deletion] still wins for
account erasure: reporter identity/evidence is minimized, and only explicitly inventoried exceptions may survive.
Do not create body snapshots, another retention policy or a legal-hold service. [Accounts governance][accounts]
owns authority/standing and mandatory-notice preferences; Content's existing Realm/target checks remain authoritative.
[Semantic][semantic] owns identity/Context and its actual subject/statement moderation APIs: subject `PostActions`
currently reaches an unsupported report target, not a cross-owner report implementation. Keep that refusal explicit;
do not invent a subject-report endpoint or extend content appeals to catalogue ownership. [Search][search] consumes
source changes/current disclosure for its public subject projection; there is no demonstrated content-body search
consumer here, and reports/appeals never become public search documents.

**Conflict for the manager before changing appeal denials:** [Content][content] and the frozen
[`content-notification-outcomes.test.ts:424`][frozen-denial] require 403 for a known appeal's unauthorized resolver;
[`appeals-http.test.ts:239`][native-denial] requires 404 before granting that resolver authority. The latter matches
`resolveAppeal`'s current `missing` denial factory. Both preserve the original decider's 403. Reconcile these
contradictory expectations before the backend denial portion of slice 3; this research changes neither test.

[content]: ../../services/kernel/src/content/README.md
[web]: ../../apps/web/README.md#board-moderation-reports-boardsidmoderation
[reports]: ../../services/kernel/src/content/reports.ts
[report-ui]: ../../apps/web/src/report/content-actions.tsx
[projection]: ../../services/kernel/src/content/report-effect.ts
[inbox]: ../../apps/web/src/inbox/inbox-read.ts
[actions]: ../../apps/web/src/moderation/actions.ts
[moderation]: ../../services/kernel/src/content/moderation.ts
[outcomes]: ../../services/kernel/src/content/report-outcomes.ts
[appeals]: ../../services/kernel/src/content/appeals.ts
[appeal-ui]: ../../apps/web/src/moderation/appeal.ts
[client]: ../../apps/web/src/kernel/client.ts
[capability]: ../goals/content.capabilities.md#moderation-reports-appeals
[deletion]: ../deletion.md
[accounts]: ../accounts.md
[semantic]: ../../services/kernel/src/semantic/README.md#authorization
[search]: ../../services/kernel/src/search/README.md#deletion-lifecycle
[frozen-denial]: ../../specs/content-notification-outcomes.test.ts#L424
[native-denial]: ../../services/kernel/test/content/appeals-http.test.ts#L239
