# Realms and Spaces: a usable community home

Proposed addition to [Community](../../services/kernel/src/community/README.md), researched 31 October 2026:
an authorized person can launch an addressed Realm home, manage it, reach every listed board/subject and see
join/leave settle. Opening a published subject preserves Realm selection through the already-owned page contract.
These are missing product requirements around existing APIs; wire details stay with their modules.

## Decision and primary evidence

Make the Space home the entry to setup, participation and curation. Keep membership, following, Realm resource
roles and Context editorial authority distinct. Show publication as “Published here”; it selects existing subjects,
without changing their identity, authorship, ownership or Global decisions. Preserve adopted privacy and
[retention](../deletion.md), including ban-reason expiry and erased actor attribution. No policy conflict was found.

- [Discourse's official category guide](https://meta.discourse.org/t/understanding-groups-and-category-permissions/87678)
  separates seeing, replying and creating. Its
  [`lib/guardian/category_guardian.rb`](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/lib/guardian/category_guardian.rb)
  separately checks reading and posting. This supports distinct controls without adopting its administrator bypass.
  Source read from `.reference/partitioned-sitemap-feeds/discourse/` at that revision;
  [GPL-2.0-or-later](https://github.com/discourse/discourse/blob/589325e2b8466178ee83acac9ec411de555a0093/README.md#copyright--license).
- [Lemmy's official API](https://join-lemmy.org/api/main) exposes separate follow, community-ban and moderator
  operations (displayed version `1.0.0-feed-only-jwt.1`, AGPL-3.0). Together these products support separate attention,
  participation and management controls. Retain REZICS's protected-ban barrier and explicit-unfollow precedence.
- [W3C SKOS §4](https://www.w3.org/TR/skos-reference/#schemes) distinguishes concepts from their organizing schemes
  ([W3C document terms](https://www.w3.org/Consortium/Legal/2002/copyright-documents-20021231)). Use existing
  `skos:ConceptScheme`/`skos:Concept` choices for board organization. **Recommendation:** keep that vocabulary separate
  from Realm membership and Semantic editorial Context authority. The tradeoff is more explicit setup choices.
  No external code is proposed for copying.

## Actual journey and gaps

Community HTTP/DTO/header authority is
[`community/routes.ts`](../../services/kernel/src/community/routes.ts); storage is
[`db/community/schema.sql`](../../services/kernel/db/community/schema.sql).

1. **Creator → addressed Space.** `createSpace` in `community/space.ts` serves `POST /v1/spaces` with title/summary,
   `Idempotency-Key` and Global `space:create`; its account/key-derived route stores `space` and append-only
   `space_revision` plus native owner grants atomically. `PUT /v1/spaces/{spaceId}/address` needs `space:manage`,
   `If-Match` and a key. `space-address.ts` resumes pending claim → Space revision → activation across separate
   address/Space partitions. `GET /v1/spaceAddresses/{address}` resolves readable
   Spaces. **Gap:** no served creation/address editor in the current community routes/components.
2. **Owner → configured Realm.** `POST /v1/realms` takes host, title, visibility and readable `contextId`, requiring
   Global `realm:create` and host `space:manage`. `realm.ts` stores one Realm and revision on the Space route;
   `PATCH /v1/realms/{realmId}` and `PUT /v1/realms/{realmId}/boardScheme` use `realm:manage`, a key and head CAS.
   An independently authorized [`POST /v1/contexts`](../../services/kernel/src/semantic/http/contexts.ts) can create
   a Context; Realm creation grants no Context authority. **Gap:** setup/configuration UI. Owners/moderators are resource grants,
   never fabricated `realm_member` rows or automatic membership in “My Realms”.
3. **Reader/member → home and participation.** Actual pages `routes/spaces/$address.tsx`, `routes/realms/$id.tsx`
   and `routes/realms/index.tsx` use `SpacePage`, `RealmMembership` and `MyRealmsPageView` under
   [`apps/web/src/community/`](../../apps/web/src/community/space.ts). Address pages start anonymously; a browser
   session read can reveal an authorized protected Realm through the Space's viewer-derived `realmId`.
   Here and below `...` means `/v1/realms/{realmId}`. `POST .../membership` accepts public self-join (`realm:join`);
   `POST .../members` admits an owner-selected account with `realm:manage`. Both return `202 {workflowId}` and
   use request keys. `community/work.ts` awaits Accounts reserve/publish before implied follow of the **Space**.
   Authoritative `realm_member` intervals live on the Realm; `access.membership_inverse` is only an account-home
   candidate index ([Accounts](../accounts.md#5-organizations-and-memberships)). `GET .../members/me` currently
   derives member/none, and `GET .../participation` checks both read and participate. **Gap:** the UI sets local
   pending after acceptance without refreshing authoritative standing; no completion-status API is exposed here. It has no follow
   control. Existing [`GET/PUT/DELETE /v1/follows/{targetId}`](../../services/kernel/src/library/personal-routes.ts)
   use `follow:read/create/delete`, mutation keys and follower-partition `library.follow`; explicit unfollow survives
   implied follows ([follow contract](../private-follow-counts.md)).
4. **Author → discussion.** `SpacePage` links boards to `routes/boards/$id.tsx`, then `$id_.new.tsx`/`PostComposer`
   and `routes/threads/$id_.$slug.tsx`. Existing [`Content routes`](../../services/kernel/src/content/routes.ts)
   create a Realm board with `POST /v1/realms/{realmId}/boards` (`board:create`, readable scheme Concept,
   participation); `POST /v1/threads` and `POST /v1/threads/{id}/posts` use `thread:create`/`post:create` and mutation keys.
   Board rows use the Realm route; thread/post/revision rows share their thread command partition
   ([Content contract](../../services/kernel/src/content/README.md)). Current reads gate the whole chain.
   **Gaps:** no board-creation control; `space.ts` discards `next` after 20 boards and 12 publications, leaving later
   items unreachable from this home. Existing thread composition and board moderation pages need no replacement.
5. **Curator → published subject and local facts.** [`publication.ts`](../../services/kernel/src/community/publication.ts)
   implements `POST /v1/realms/{realmId}/publications` with `{subjectId}`, `realm:publish`, subject readability and a
   key; later heads use `If-Match`. `:withdraw`/`:reject` use the same action, key and current head. Realm-partition
   `publication`/`publication_head` commit the decision and outbox event together; the shelf reads adopted heads
   directly, without a Context grant or identity write. Independently authorized Semantic candidate
   `:accept`/`:reject` (`context:accept`) and `POST /v1/subjects/{id}:adopt` (`context:adopt`) use Context and expected heads
   ([Semantic](../../services/kernel/src/semantic/README.md#request-authorization)); decisions live on the subject
   route in `acceptance_current`/`adoption`, with Global inheritance and asynchronous `semantic_links` projection
   in `semantic/links.ts`. **Gaps:** no publication controls; `SpacePage` links ordinary Global subject URLs and
   `space.ts` reads summaries without Context. The already-owned [Realm page contract](../subject-pages.md#realm-context)
   specifies `POST /v1/pages:read` Realm selection, current publication/ban revalidation and truthful Global fallback;
   `presentation/reads.ts` has no Realm binding yet. Reuse that implementation work, including its frozen outcomes.
6. **Member/moderator → leave or ban.** `DELETE .../membership` returns a leave workflow keyed by the current
   reservation, not the supplied UI key; Accounts closes Realm authority before releasing the inverse. Leave does
   not unfollow. [`ban.ts`](../../services/kernel/src/community/ban.ts) backs keyed `PUT/DELETE .../bans/{accountId}`
   and `GET .../bans` under `realm:ban`: ban records and join/participation denials commit on the Realm, then existing
   membership removal runs with the moderator's restored authority. Protected reads deny immediately, including
   independent grants and protected boards inside public Realms; public reads retain the anonymous floor. Unban
   does not rejoin; existing follows remain. Owner/moderator targets require role removal first (409).
   **Gap:** no Realm ban/unban surface; board reports are a different job.

## Product slices for owner adoption

Each slice extends the existing owner's writer, with primarily product changes (at least 60% of changed source)
and at most two focused outcome tests in the existing suites. Do not commission another implementation writer.

- **Launch a usable home — Web, coordinated by Content.** Extend `community/space-actions.ts`, `space-page.tsx`
  and the existing Realm entry pages with setup using the writes above: Space/address, Realm settings, existing
  Context/scheme and first board. Dependencies are existing Community/Content commands and Semantic vocabulary reads.
  Outcomes: a permitted creator reaches the addressed home and opens its board; retry/head conflict preserves the
  created identities and entered work. No automatic Context or Global grant.
- **Finish joining/leaving — Web with Content/Accounts.** Update `realm-membership.tsx`,
  `realm-membership-queries.ts` and `space-actions.ts` to refresh authoritative standing while pending and My Realms
  after settlement. Use bounded refresh and a manual retry state when still unsettled; do not invent a status API. Add
  independent Space follow controls through existing Library commands. Outcomes: join/leave settles visibly;
  explicit unfollow remains after leave/rejoin. Protected self-join stays unavailable; use existing owner add-member.
- **Reach every listed item — Web.** Preserve both native cursors in `space.ts` and expose separate continuations
  in `space-page.tsx`, keeping current read bounds per page. Outcomes: a later board/publication is reachable;
  unavailable or denied results never become an invented empty directory. No new directory or Search producer.
- **Curate a subject here — Web with Content; Semantic owns page binding.** Add publish/withdraw/reject actions
  beside the existing shelf in `space-page.tsx`/`space-actions.ts`, using current publication heads. Carry Realm
  selection into the existing subject entry only after the adopted page binding is available. Outcomes: publication
  opens the same subject with the local facts label; withdrawal yields the contract's Global fallback without
  modifying Global identity/facts. Reuse frozen Realm-page race/denial cases instead of duplicating them.
- **Enforce a Realm ban — Web with Content.** Add a Realm management section to `space-page.tsx` backed by existing
  ban list/mutations; keep board report resolution in its current page. Outcomes: a moderator's ban immediately
  hides protected material before removal settles; unban permits subsequent admission without restoring membership.
  Reuse Content's existing protected-ban acceptance work, with one UI outcome covering the management action.

The [community review](community-done-when-review.md) and [Realm subject research](realm-subject-candidates.md) are
inputs, not completion evidence. Search consumes its existing safe public sources; no publication-to-Search
producer is implied. Reuse existing Semantic page/editorial, Content protected-ban and Search filter work rather
than duplicating it. No Zones, custom vocabulary release, new permission model or new harness is proposed.
