# Posts, threads and boards: owner-contract proposal

Desk research, 2026-10-31. Proposed adoption in [Content](../../services/kernel/src/content/README.md) and
[Web](../goals/web.md): finish targeted replies and revision provenance, and make bounded board traversal
understandable. Reuse the existing editor, API and projections. This evidence does not establish In-row completion.
The [earlier review](content-done-when-review.md) is context; its implementation/test repairs are not redispatched here.

## Primary evidence and decision

- Discourse exposes reply targets in
  [`app/serializers/post_serializer.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/serializers/post_serializer.rb).
  Its [`app/controllers/posts_controller.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/app/controllers/posts_controller.rb)
  separates history visibility, deletion and recovery; `lib/post_revisor.rb` checks the expected body under a lock.
  Adopt explicit reply context and conflict-aware edits; retain REZICS's immutable revisions rather than Discourse's
  configurable revision/grace-period behavior.
- [RFC 8785 §3.1](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1) preserves string data during
  canonicalization. [SPDX](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/)
  distinguishes listed identifiers and local licence references. Recommendation: preserve authored text and the
  recorded licence through edits; keep Content's existing identifier/`LicenseRef` subset, without a relicensing UI.
- [ActivityPub §6.4](https://www.w3.org/TR/activitypub/#delete-activity-outbox) permits tombstones in references
  and absence responses. Adopted [deletion](../deletion.md), retention and disclosure policy wins: retain the
  30-day author undo window, immediate account-erasure rules and existing status codes. Federation stays outside this work.

The shared pattern is stable reply/revision identity with separately controlled availability. Applying it costs
some reply/provenance UI and bounded reference resolution; it requires neither an unbounded reply tree nor another
content authority. Standards identify useful patterns, not a new REZICS permission or retention policy.

## Actual UI → API → storage → visible result

Here `W = apps/web/src`, `C = services/kernel/src/content`. Wire authority remains
[`C/routes.ts`](../../services/kernel/src/content/routes.ts) and
[`C/schemas.ts`](../../services/kernel/src/content/schemas.ts).

1. **Discover/read:** `W/routes/spaces/$address.tsx` and `W/routes/realms/$id.tsx` reach
   `W/community/space-page.tsx:SpacePage/Boards`; `W/community/space.ts:readHome` reads
   `GET /v1/realms/{realmId}/boards`. Links open `W/routes/boards/$id.tsx:BoardPage`.
   `W/identity/page-loaders.ts:loadBoardPageWithAuthors` reads the board and
   `GET /v1/boards/{id}/threads`. `BoardSortNav` maps Active/Hot/New to `active`/`hot`/`newest`.
   `C/boards.ts:listBoardThreads` examines at most 200 indexed candidates and hydrates current disclosure,
   returning `{threads,next,rankRefreshedAt}`. **Gap:** an empty page with `next` is labelled an empty board.
   A Global board-directory journey is absent from these surfaces.
2. **Open/compose:** `W/routes/threads/$id.tsx` redirects to
   `W/routes/threads/$id_.$slug.tsx:ThreadPage`; `W/threads/thread-page.ts:loadThreadPage` reads
   `GET /v1/threads/{id}` and `GET /v1/threads/{id}/posts`. `PostSlot` renders paged posts.
   `W/routes/boards/$id_.new.tsx:NewThreadPage` uses `PostComposer`/`startThread` for
   `POST /v1/threads` (`thread:create`), then navigates to the returned thread.
   `replyToThread` uses `POST /v1/threads/{id}/posts` (`post:create`) and renders the returned post.
   Writes carry session bearer, CSRF protection and idempotency key. **Gap:** `W/threads/actions.ts` neither
   accepts nor sends `parentId`; the page offers no targeted reply although the API/storage support it.
3. **Edit/history:** `InlinePostEditor` and `W/threads/post-writes.ts:revisePostRequest` call
   `POST /v1/posts/{id}/revisions` (`post:revise`) with a key and revision `If-Match`; 412 keeps the draft.
   `W/threads/post-history.tsx:PostHistory` → `readPostHistory` → `GET /v1/posts/{id}/revisions`
   pages 20 revisions, displaying body, author, time and licence. Exact
   `GET /v1/posts/{id}/revisions/{revisionId}` exists, but no served exact-revision page does.
   **Gaps:** site edits force `LicenseRef-rezics-terms` although `C/commands.ts:revisePost` inherits an omitted
   licence; history omits revision-specific subject/vote references. `ThreadSubjects` shows current thread subjects.
4. **Delete/undo:** `PostSlot` → `erasePostRequest`/`restorePostRequest` calls
   `DELETE /v1/posts/{id}` / `POST /v1/posts/{id}:restore`, with `post:erase`, keys and 204 responses.
   `C/erase-post.ts`, `restore-post.ts` and `deleted-post-purge.ts` retain the tombstone, restore the same
   revisions before 30 days, then purge in bounded work. `RemovedPost` preserves reply placement and author-only
   restore controls. Opening-post deletion hides the title, retaining replies; history is empty and exact revisions
   return 404. Review-slot conflict returns 409. These steps already exist.
5. **Moderate:** `W/routes/boards/$id_.moderation.tsx` loads `ModerationReportsView`/`ModerationAppealsView`.
   `W/moderation/actions.ts` calls existing thread/post `:takeDown`, report `:dismiss`, and appeal `:resolve`
   commands with bearer/key. `C/moderation-routes.ts`/`appeals.ts` enforce authority and retain decisions;
   withheld posts have no body, and appeal reversal restores ordinary readability. Moderator reversal is separate
   from author undo and irreversible erasure.

`C/commands.ts` atomically stores thread, post, immutable `content.revision`, grants, receipt and outbox in one
partition. Discussion routing uses `threadTargetAtRoute`; reviews use the author's route; replies/revisions remain
on the thread route. `services/kernel/db/content/schema.sql` enforces body/digest consistency.
`C/document.ts` uses the shared canonical serializer. References are existing `subjectIds`, `boardId`, `mediaIds`
and optional `voteCitation`, not a generic refs store.

`C/relays.ts` registers `board-projection.ts:createBoardEffect`: committed thread/post/revision events update
`content.board_thread` on the board route in a separate guarded command and emit `board-thread.projected.v1`.
`C/work.ts` refreshes ranks asynchronously. Direct responses can render before board/subject candidates converge;
current board/Realm/Access checks govern reads, never candidate membership. Reply/mention notices use existing
publication effects and recipient checks. This is inspected wiring: recorded stories and fake-kernel UI tests do
not prove served kernel integration or asynchronous completion.

## Small owner-contract changes and implementation slices

Content should adopt these observable guarantees; Web owns their presentation. All three use existing dependencies.
Add the few outcome cases alongside current suites in new adjacent files; preserve existing/frozen acceptance.

1. **Reply to this post — Web, consuming Content parent validation.** Change
   `W/routes/threads/$id_.$slug.tsx`, `W/threads/actions.ts`, `W/threads/composer.tsx`: select/cancel a parent,
   focus the same composer, submit `parentId`, render reply context. Retain target/key on retry; a changed target
   starts a new command intent. Link locally when the parent is loaded, otherwise show neutral context without
   fetching an ancestry tree or copying hidden text. Keep Content's 32-parent bound and ordinary refusals.
   Two outcome cases: retry creates one reply to the selected parent; reload after parent deletion retains its
   relationship/tombstone.
2. **An edit retains provenance — Web, consuming Content inheritance/history DTOs.** Change
   `W/threads/post-writes.ts` to omit licence for ordinary edits, retaining new-post defaults. Extend
   `W/threads/post-history.tsx` and `reads.ts` to show each revision's stored subject/vote references alongside
   its licence. Resolve labels through bounded existing Semantic summaries; show recorded vote units/revision,
   never today's vote. Keep unavailable references neutral and document/block identities intact.
   Two outcome cases: edit retains a non-default licence; two revisions display their own differing references.
   No new citation producer or revision endpoint is required.
3. **Continue past an empty page — Web, consuming the board DTO.** Change `W/routes/boards/$id.tsx`:
   an empty `threads` array with `next` means no visible threads on this page, with Next retained; use the terminal
   empty message only without continuation. One outcome case advances from an empty page to a visible thread under
   the same sort. Add no totals, hidden-candidate explanations or client loop draining candidates.
4. **Pin a board thread — Content, consumed by Web controls.** Keep at most three indexed pin slots per board, newest
   first; repeating the current desired state preserves order and unpinning compacts slots. Return the bounded,
   currently disclosed `pinnedThreads` section beside the existing active/hot/newest page, exclude pins from that
   page, and bind continuation to this representation while advancing across sparse candidates. The native mutation
   reruns current moderator and board/thread/container read authority before receipt replay and never grants
   visibility. One focused HTTP outcome covers moderator, member, banned and hidden-thread behavior, cap/order,
   idempotence and continuation. Web owns the controls.

Content adopts the second-scope outcomes in [public scope](../scope.md): Realm rating sorts, pins, slow mode, watch,
public Collection/review/Space discovery and the moderator workbench. Email notifications and account mute/block
remain deferred.

[Accounts/Access](../../services/kernel/src/access/README.md) retains standing/grants;
[Community](../../services/kernel/src/community/README.md) retains Realm participation and membership boundaries;
[Semantic](../../services/kernel/src/semantic/README.md) retains identity, readable labels and Context.
[Search](../../services/kernel/src/search/README.md) is a subject projection, not an existing thread-search API;
it consumes adopted source eligibility/events. Keep existing moderation, notices, ranking and deletion work with
those owners. Articles/hosted media expansion stays closed. Aim for product code/copy to constitute at least 60%
of implementation changes; five outcome cases support the product slices without another harness.

Sources read on 2026-10-31: reused `.reference/partitioned-sitemap-feeds/discourse`, commit
`589325e2b8466178ee83acac9ec411de555a0093`, GPL-2.0-or-later (`README.md`, `LICENSE.txt`), source only.
RFC 8785 carries IETF Trust/BCP 78 terms; ActivityPub links its W3C permissive document licence;
SPDX 3.0.1 identifies Linux Foundation/contributor copyright. No source files or passages are proposed for copying.
