# Content

Content owns boards, threads, posts, immutable documents, media state and publication, and content governance operations.

A `BoardView` includes `realmId`, which is the containing Realm id or `null` for a board without a Realm. The field is
output-only and comes from the board row used for disclosure.

## Global boards

`POST /v1/boards` creates a board in Global Context. It requires `Idempotency-Key` and the strict body
`{ conceptId, title, purpose, visibility }`, with purpose `discussion | reviews` and visibility
`published | protected`. It returns 201 `{ board }` using the Realm board DTO, with `realmId: null`, and the
same problem codes as Realm board creation. The actor needs `board:create` on Global Context and `subject:read`
on the Concept; no Realm role reaches this authority and Global Context has no board scheme. Governance holds
the creation permission through grants. Creation checks the Concept's type and read authority directly, without
waiting for subject-link projections. A board is placed at `newId(routeOf(conceptId))` and initialized with the
same resource grants as a Realm board. Protected Global boards require explicit read and write grants.
There is no uniqueness by concept or purpose; each new key creates a separate board and a replay returns its board.
`POST /v1/realms/{realmId}/boards` retains its Realm scheme and uniqueness rules.

## Notifications

Content owns minimal in-app notices for `reply`, `mention` and `moderation_decision`, using the names in accounts'
notification catalogue (`src/access/notification-kinds.ts`). Accounts owns the preferences and `notificationAllowed`.
There is no email delivery in this scope. These sections specify the pending implementation; they do not claim that
notification or appeal routes already exist.

A published post with a parent notifies that parent's author with `reply`. A published post without a parent
notifies the thread's opening-post author. Creating the opening post never notifies its own author. A `mention`
inline node with `attrs.accountId` in a post's first published revision notifies each distinct named account, in
document order, up to the first ten. Duplicate nodes do not consume additional slots. A draft sends nothing;
its first publication uses that published revision's mentions. Later revisions send no mentions. Web adds the
mention node to `packages/document`.

For these post notices a recipient gets at most one notice per post, with `reply` winning over `mention`.
The actor never receives their own notice. A nested reply does not independently notify the opening-post author;
that author can still receive a mention. Moderation outcomes are separate sources: a takedown notifies the target's
author with its decision, a report resolution notifies the reporter with `actioned` or `dismissed`, and an appeal
resolution notifies the appellant.

Content effects on committed events write notices on the recipient's route. Each notice is unique on
`(recipient, kind, source)`; replay adds nothing. A post notice uses the post as its source. A takedown, report
outcome and appeal outcome each use their own source identity, so an appeal resolution can notify the author
after the original decision did. Each notice stores only its identity, kind, time, actor id (`null` for moderation)
and target ids: thread and post, or decision and report as applicable. It stores no text. The inbox links to the
author-readable decision or reporter-readable report for statements, deadlines and outcomes.

When the effect runs, each candidate first passes accounts' `notificationAllowed`; `reply` and `mention` then
pass the same current Access read check as a post read, including the thread, ancestors, board and Realm. A failed
check writes nothing and is never retried, including on event replay after preferences or membership change.
Deleted accounts receive nothing. Moderation decisions are mandatory through the catalogue's preference override:
they still use accounts' check, but turning the kind off cannot suppress them. They do not require the recipient
to read the taken-down target.

`GET /v1/accounts/{accountId}/notifications?limit=&cursor=` lists the authenticated account's inbox;
`GET /v1/accounts/{accountId}/notifications/count` returns its unread count, and
`POST /v1/accounts/{accountId}/notifications:markSeen` advances its seen marker with `{ through: <notice id> }` and an
`Idempotency-Key`. The inbox is private to its account. Naming another account returns 404 for list, count and mark seen. The GET list returns newest
first, using an immutable notice ordering to break time ties. `limit` is 1–50, default 20. Its opaque shared list
cursor (`src/tokens/list-cursor.ts`) binds the viewer and list query. Each item contains `id`, `kind`, `createdAt`,
`actorId`, target ids and `unread`. Reply and mention candidates pass a current batched post read check; unreadable
ones are skipped without exposing their notice or post ids, including through a cursor. A page scans at most
four times its limit, advancing past scanned candidates even when none can be returned, as subject threads do.

The unread count reads at most 101 index rows and returns `{ count, capped }`: `count` is at most 100, and
`capped` is true only when more than 100 unread notices exist. Exactly 100 returns `{ count: 100, capped: false }`.
Mark seen takes an owned notice id and advances the marker only forward in the same immutable inbox order.
Items at or before the marker are read; marking an older item cannot make newer seen items unread again.
Notices older than 180 days are deleted in bounded batches. Account deletion erases its notices and seen marker.

Notification costs are bounded independently of inbox or thread size:

- Reply delivery considers at most two candidates and writes at most two notices per post (the single-parent
  rule above currently selects at most one). Mention delivery considers and writes at most ten. Each candidate
  has one `notificationAllowed` check and, when allowed, one Access check; recipient overlap is deduplicated.
- Report outcomes write at most one notice per report, amortized against that report's creation. A takedown
  resolves open reports in bounded batches rather than requiring an unbounded synchronous fan-out.
- List uses one index range of at most `4 × limit` rows plus a batched read check. Count reads at most 101 index
  rows. Mark seen moves one row; no inbox scan is needed.
- Retention deletes bounded batches on recipient routes. Account deletion removes notices in bounded batches
  and its one seen marker; neither cleanup requires one transaction over an entire inbox.

## Appeals

Each thread or post takedown stores a decision with its target, action, moderator's statement (the takedown
`reason`), decider and time. Its author can read the decision even though the target is taken down, including
the statement and appeal deadline. An unrelated account receives 404. A takedown marks the target's open reports
`actioned`; a moderator can instead mark an open report `dismissed`. A report receives at most one outcome and
one outcome notice. A later takedown does not replace an already dismissed outcome.

Only the target's author may appeal, once per decision, with a statement of at most 2,000 characters. The appeal
deadline is the decision time plus 183 days, inclusive; the next instant is late. A second appeal returns 409,
including after resolution. A first appeal after the deadline returns 422. An unrelated account cannot read or
appeal the decision (404); an overlong statement returns 422 without consuming the author's appeal opportunity.

An account with `moderation:takedown` on the target, other than the original decider, resolves a pending appeal
with a statement. The original decider and accounts lacking that authorization receive 403. `uphold` keeps the
takedown. `reverse` restores the target, makes it readable under its ordinary disclosure rules, raises its security
revision and emits a restore event. The resolution notifies the appellant with a mandatory moderation outcome.
Pending appeals appear alongside reports in the moderator queue and leave it on resolution. This scope covers
content targets only, not other owners' takedowns.

The executable API contract is `specs/content-notification-outcomes.test.ts`, with the test-only interface in
`specs/content-notification-driver.ts`. `CONTENT_NOTIFICATION_DRIVER` selects a real product binding exporting
`createContentNotificationDriver()`; without it every scenario fails with
`Content notification outcome driver is required`. The suite remains red until that binding and the product
implementation exist. The specification verifier checks this intentional red state without substituting a driver.

## Reviews

Global Context may hold several reviews boards, and a Realm one.

A review is a thread of kind `review` on a reviews board, with exactly one target subject. Its opening post may
cite the author's current vote by question, units and revision. Each citation is stored on an immutable post
revision and is never rewritten when the vote changes; a later post revision may cite a newer vote.

The review thread, its posts and its revisions live at the author's route, in the author's partition. This keeps
the vote primary-key read and the one-live-review index probe in the same partition as the write, and distributes
a popular board's reviews across authors instead of accumulating them in the board's partition. At most one live
review exists per author, subject and board. Removing it releases that slot permanently for that thread.

`createThread` checks the board purpose during its existing board validation: reviews require a reviews board,
and discussion threads require a discussion board. The `board_identity` trigger makes purpose immutable, so this
command check cannot race a purpose change. Thread insert and update triggers never read the board. Board
listings and the subject thread index receive reviews through the same projections as discussion threads whose
boards live in other partitions.

## Subject threads

`GET /v1/subjects/{subjectId}/threads?place={id}&kind=discussion|review&limit=&cursor=` returns a subject's threads
for one Global Context or Realm and one kind. `limit` is 1–20, default 20. Results are ordered by last activity,
newest first, with the indexed thread id as a stable tie-breaker. The signed keyset cursor binds the subject, place,
kind, viewer and subject partition epoch. It does not use an offset or a count.

The route returns a 404 for an unknown or unreadable subject. Index rows are candidates only: each candidate passes
the current thread, opening post, board, Realm and Access disclosure checks, and the final snapshot confirms that the
thread still references the subject and its board still belongs to the requested place. Hidden or stale candidates
are skipped without returning their ids. A page scans at most four times its requested limit, then returns a cursor
when more candidates may remain. Subject counts stay with semantic.
Reads of a Realm-owned board, thread or post require `realm:read` on its containing Realm at the read's authorization time. Active members of a protected Realm receive this through the `community.realm.member` group grant. Non-members and members whose leave has settled receive the same `404` as an unknown target. Public Realm reads retain their public eligibility.

Threads and posts can be taken down with `moderation:takedown` on the target or on its containing Realm. Realm owners and moderators carry that action for content in their own Realm; neither a parent resource nor another Realm grants it. Authorization is checked before receipt lookup, so a denied replay remains denied. Board and media takedown authorization is unchanged.

Authors erase their own posts with `DELETE /v1/posts/{id}` and an `Idempotency-Key`. The route uses the authenticated native identity and the existing `post:erase` owner permission; erasure remains separate from moderation takedown. Success and authorized replay return 204 with the stored session position. The request commits one tombstone and the existing ID-only `com.rezics.content.post.erased.v1` event, without loading or clearing revision bodies.

Media owners erase their own media with `DELETE /v1/media/{id}` and an `Idempotency-Key`. The route requires the current media owner and denies collection-pending media; success and authorized replay return 204 with the stored session position.

Published erased posts remain in thread pages as `removed: true` with `body: null`. Their history is empty and exact revision routes return 404 immediately, before physical cleanup. Replies retain their parent and order. Erasing the opening post preserves the thread and replies; the existing logical erasure leaves the stored thread title unchanged, while thread disclosure returns `title: null`.

`clearErasedPostRevisions(pool, { postId }, deadline)` clears retained revision bodies, their SHA-256 digests and search text using the committed tombstone as authority. Each digest is cleared in the same statement as its body, since retaining a hash would let a reader confirm guesses about erased text. It runs `null-erased-revisions.sql` in atomic pages of 100, releases each connection between pages and can safely run again. It changes no revision of an available post. This module exports the cleanup for direct invocation; worker registration and consumption of the post-erased event belong to the content work integration.

## Author items

`content.author_item` keeps candidate threads and replies on the author's route for profile reads. The
`content_author_item` effect handles thread creation, reply creation and ID-only post erasure with one guarded
command in the author's partition per event. `actorId` supplies the author and the creation event's `activityAt`
supplies its original creation time, including microseconds. Thread creation emits only `thread.created.v1`, whose
`itemId` is the opening post; the index stores the thread identity instead, so the opening post is never a reply.
Both discussion and review threads retain their kind, and replies retain their containing thread. Erasure reads
the retained post's author by primary key in the thread's partition and releases that connection before the author
command. Missing posts and unchanged rows do nothing; receipts make committed replay inert and the source epoch
and position guard rejects stale writes. No backfill is needed.

`GET /v1/accounts/{accountId}/threads?kind=discussion|review&limit=&cursor=` returns `{ threads, next }` in
board-list summary shapes. Kind defaults to `discussion`; reviews use their own section. Threads are ordered by
creation time descending, then item id ascending. `GET /v1/accounts/{accountId}/posts?limit=&cursor=` returns
`{ posts, next }`: reply entries include `thread: { id, title }`, with a null title when thread disclosure hides it.
Opening posts belong only to the thread list. Both limits are 1–20, default 20.

Each page reads the account's public views once in its own partition before scanning candidates. The `posts` view
controls discussion threads and replies; the `reviews` view controls review threads. A private view returns an empty
page with `next: null`, except to the account itself or a viewer authorized by the existing `account:update`
presentation rule, including an organization's acting owners. The view read shares the candidate page's repeatable-read
snapshot, which commits before thread and post disclosure probes. Hiding a list does not change any item's own
visibility. Deleted, fenced and unknown accounts have private flags and empty pages.

Takedown, visibility and Realm changes are not mirrored. Index rows are candidates only: reads apply the current
thread, opening post, board, Realm and Access disclosure checks, and posts also pass their own disclosure checks.
Drafts, taken-down and erased items are omitted, including when exact reads would disclose an erased slot. An erased
opening post may still supply a reply's null thread title. Unknown, deleted and fenced accounts have empty pages from
the public-view check before any candidate scan. No membership or item count is returned.

Each page reads at most four times its limit in candidates and returns a continuation when more may remain, even
if filtering leaves the page empty. The signed keyset cursor binds account, list, thread kind, viewer and author
partition epoch. Its keyset position is also encrypted so a skipped item's identity cannot be decoded from the
continuation. Two disjoint index seeks handle timestamp ties and older rows within one combined scan budget;
there is no offset. The thread index includes kind, while a separate partial reply index spans both thread kinds.

## Sitemap feeds

`GET /v1/sitemap/boards` and `GET /v1/sitemap/threads` are the server-to-server feeds behind the sitemap shards in
[Search engines and sharing](../../../../docs/seo.md#sitemaps). Both declare `x-exposure: public`, use the public read
rate limit and return `{ items, next }`, where every item carries `lastModified` (an RFC 3339 instant). A board item is
`{ id, lastModified }`; a thread item is `{ id, title, lastModified }` with a `null` title when the thread shows none.
The kernel returns no URL or slug; web builds them. `SitemapQuerySchema` and `sitemapPageSchema` in `schemas.ts` are the
shared shape that other modules' feeds reuse.

These feeds return up to 1,000 entries per page (`limit` 1–1000, default 1000), an exception to the shared list
maximum of 100. `cursor` is an opaque string from a previous `next` and is bound to its feed; any other value is
`invalid_cursor`. The position uses the shared opaque list cursor contract in
[`../tokens/list-cursor.ts`](../tokens/list-cursor.ts), bound to the feed route, anonymous viewer and empty query.
Skipped candidates reveal no identity, route or creation time.

A feed evaluates as the anonymous reader even when the request carries a bearer, and lists exactly what an anonymous
reader can open:

- **Boards:** published and not taken down, with no Realm or a public Realm, and with at least one listed thread. An empty board is a thin page and is not listed.
- **Threads:** published and available, on a listed board, passing the thread disclosure of the anonymous
  `listBoardThreads` page (the shared `discloseThreads`), with an available opening post.
- Nothing under a protected Realm or a removed board, and no draft, protected, taken-down or erased thread, is listed.

Keyset order uses immutable keys: boards by `(route, board_id)`, and threads board by board through
`board_thread_page_idx` by `(created_at, thread_id)`. A walk lists every item that stays listed for the whole walk
exactly once. Threads under protected Realms and removed boards are never read. The board feed probes threads
newest first and resumes an unfinished probe on the next page, so any number of newer hidden candidates cannot
make a board with a listed thread disappear.

Board items come in strictly increasing `(route, id)` order. Thread items are board-major: boards follow that same
order, then each board's threads follow `(created_at, thread_id)` order. Thread items do not carry either key, so a
client cannot verify their order from the response alone.

A page examines at most 4 × `limit` candidate rows. When it reaches that cap it returns what it found with a non-null
`next`, possibly with no items; clients follow `next` until it is `null`.

`lastModified` is the last significant change of what the page shows, from columns the write paths already maintain:
for a thread `board_thread.last_activity_at`; for a board its newest listed thread's `created_at` (or its own
`created_at` if there is none, though thin boards are omitted). Post edits and
removals do not advance it, and no feed adds a write-path update, index or migration.

## Reactions

People have one reaction slot per thread, post or subject. Threads and posts accept upvote, downvote, like, love, laugh,
insightful and sad. Subjects accept like, love, laugh, insightful and sad; their semantic score remains the subject's
rating. Subject reactions require the actor to be admitted and hold `reaction:set` on the Global Context (route 0),
then require the subject to be readable at the same authorization time as a subject read. After semantic setup,
`setupContent` installs this standing grant for every active account. Its independent `content.setup` installation
runs once across restarts, including after platform governance revokes the grant. Suspension ends standing for that
account. A grant on an individual subject does not authorize reactions. Unknown or unreadable subjects return not
found. A merged subject id resolves to its survivor, and the slot is written on that survivor. Subjects have no board, Realm
participation or board Access step.

Subject reaction changes use `com.rezics.content.reaction.changed.v1` with `targetKind: subject`. The relay maintains
the existing per-kind counts and total in the subject's partition. It also maintains one `content.subject_reactor` row
per reacting account in that same partition and transaction. Clearing a reaction or erasing an account removes the
reactor row through the relay.

A `com.rezics.subject.merged.v1` event starts one idempotent DBOS job for the merged subject. The job reads its
`content.subject_reactor` rows in actor ID keyset order from that subject's partition, up to 100 IDs per page. For
each actor it runs one command in the actor's partition and resolves the current final survivor with `resolveSubject`
at that command's T, so a later chained merge is followed. A source slot moves with its kind when the actor has no
survivor slot. When both slots exist, the source slot is cleared and the survivor slot stays. Every slot change emits
the ordinary reaction change event; the relay updates counts and reactor rows, and the merge job never writes counts.

The last actor ID in a page is the cursor. Each page step stores its result in the DBOS job state, so a restarted job
continues after the last completed page. Re-running an uncheckpointed page is safe: an actor whose slot already moved
has no source slot and produces no second change event. A final empty cursor check follows an exact multiple of 100.

## Covers

When authorization is supplied, a cover claim requires execute authorization on the subject or `statement:propose` or `subject:create` on the Global Context, with the subject in the command partition.

A cover is a media object with purpose `cover`, named by a `schema:image` statement on its subject. One subject can have several images; the preferred-rank statement is its cover. An edition's cover belongs to the edition. A work without its own cover shows the cover of its representative edition, which the work names with one statement, so choosing a cover is one indexed read and never a scan of the work's editions. A work may name one representative edition per language; the cover then follows the same language choice as the title, so a reader never sees a title in one language over a cover chosen for another.

### Variants and metadata

Image publication decodes the original once and writes AVIF and WebP variants at fixed widths (320, 640, 960, 1280, 1920 and 2560 pixels, never enlarged; an image narrower than 320 pixels keeps its own width). The original is kept for reprocessing and never served to the public. Publication also records, on the media row:

- the original width and height, so a client knows the image's ratio before loading it;
- a placeholder: a ThumbHash of at most 32 bytes and the average colour, so the frame is painted while the image loads;
- an optional authored crop, a Media Fragments `xywh=` rectangle chosen by an editor (to remove a scan border, a store badge or a letterbox); variants are cut from the crop, and the original stays untouched;
- an optional focal point inside the crop, used when a client fits the image to a frame of another ratio.

Metadata is stripped from every variant. Variants are deterministic, so a reprocess with the same settings produces the same keys. Every image within the upload limits (20 MiB, 40 million pixels) gets variants; no valid cover is replaced by a placeholder because it is large, and no original is ever served in place of a variant.

An importer that fetches a source cover stores it through this same path, with the source's cover role mapped to `cover` (not to a gallery or screenshot role); a source record whose cover is missing or rejected leaves the subject without one, and the import report says why.

### The cover summary

Every read that returns a subject for display (subject read, search hits, collection members, library entries, inverse relation pages, thread attachments) returns a cover summary with it, in the same response:

```json
{
  "media": "0192…",
  "width": 1200,
  "height": 1800,
  "placeholder": { "thumbhash": "…", "color": "#5a4632" },
  "variants": [
    { "format": "avif", "width": 320 },
    { "format": "webp", "width": 320 }
  ],
  "focalPoint": { "x": 0.5, "y": 0.5 },
  "credit": { "rightsHolder": "…", "via": { "name": "…", "url": "https://…" }, "license": "…" }
}
```

or `null` when the subject has no cover the reader may see. A missing, rejected, erased, taken-down or withheld cover is `null` (or carries a `withheld` reason for suitability), never an error, so a page never fails or waits because of an image. The summary is read with the subject in the same batched read; it never costs one request per item.

The summary's width and height describe the authored crop when one exists, or the original otherwise. Its ThumbHash is base64, its colour is the stored average colour, and variant entries are ordered by ascending width. `focalPoint` is null when no focal point was authored.

### Serving

Cover variants are served by the website's media route like every other media object: each request, conditional ones included, asks content for a decision, published bytes are sent `private, no-cache` with the SHA-256 as `ETag`, and a takedown or erasure takes effect on the next request. A page with k covers therefore costs k download decisions, so a page requests only the covers it shows: previews cap their items, and covers below the first viewport load lazily. Cover summaries are resolved from the media's current state at read time, so a takedown, erasure or rights change removes the cover from every summary at once and no page links to a removed image.

### Rights

Every imported cover carries its rights holder, the source it came through and its licence, and is credited where it is shown. A cover comes down on a valid complaint through the media takedown path, and its subject then shows its placeholder. The takedown also fences the source record's cover field, so a later import refresh cannot bring the same cover back.

## Avatars

An avatar is an image media object with purpose `avatar`. Its container and uploader are the same account,
so it lives in that account's partition. Only the admitted account using the website client may reserve and
complete it, with the same image types and upload limits as post images. The image job produces the same
variants, ThumbHash and average colour. Available avatar variants are public; originals and pending, rejected,
taken-down, erased or collection-pending avatars are never served. Owners erase avatars with the existing
`DELETE /v1/media/{id}`.

Reserve an avatar with `POST /v1/media`, setting `purpose: "avatar"` and `containerId` to the authenticated
account id. Another account's container returns 404, even with a creation grant; `newThread` remains exclusive
to post images. The reservation response and `GET /v1/media/{id}` include `purpose: "avatar"` alongside the
existing reservation metadata. Complete the upload with `POST /v1/media/{id}:complete`, supplying the account
container, reservation request id, byte count and SHA-256; its response is `{ media: { id, state: "uploaded" } }`.
Post-image request and response shapes are unchanged.

Avatar reservation uses the existing media reservation work with the account in place of the thread or post
container. It adds no statement, keeps the same bound and uses the existing media reservation growth check.

Access stores the selected media id on the account and calls `checkAvatarMedia(client, mediaId, accountId)`
inside its set-avatar command. The port checks availability, purpose and container with one primary-key read
in the account's partition. `readAvatarSummaries(client, ids)` accepts 1–256 input ids, deduplicates them and
returns a map with one statement per media partition. Each available avatar has the cover summary shape with
`credit: null`; unknown, unavailable and non-avatar ids map to null. An account upload has no source credit.

## Source fences

`content.source_fences` retains one stable `(route, source, external_id, field_group)` tuple independently of
subject identity. `takedownSourceFence` authorizes platform governance at the command's authoritative time before
writing only the tuple's partition. The first takedown stores that command time in `taken_down_at` and a new
route-local UUID in `takedown_id`. Takedown never reverts; repeats increase `security_revision` and preserve both
original values. While a takedown remains active, the database guard rejects partial pairs and any change to its
provenance. A reset can end the period only while clearing both provenance fields; no command does this in this scope.

Every `com.rezics.content.source_fence.taken_down.v1` event reads the original pair back from the row as optional
`takenDownAt` and `takedownId`. The time uses the kernel's authoritative PostgreSQL timestamp text, preserving
database precision. Rows already taken down before these fields existed keep both null and their events omit both;
neither migration nor replay derives them from a revision or delivery time. Existing v1 events remain valid.

The internal `readFences` read returns that same optional pair as `takenDownAt` and `takedownId` in its existing
partition-local statement. Legacy takedowns, standing fences and missing tuples omit both fields.

`(takedownId, takenDownAt)` identifies one takedown period; repeats within the period keep the same pair. The first
scope has no fence restore, so a period never ends and its pair never changes. Fences hide imported data and keep
it, as [Deletion](../../../../docs/deletion.md) requires. A future restore will end the period with its own event
carrying that period's `takedownId` and clear the current pair. A later takedown starts a new period with a fresh id
and time. Consumers key on `takedownId` and never assume one period per tuple.

## Authored field documents

An authored field document stores the editor's canonical document body, SPDX licence and BCP 47 language in
`content.authored_field`, beside the subject's route. Its row binds the body to the semantic subject, candidate and
revision, and records the acting account as `author_account_id`. `appendAuthoredField` requires a current execute command:
without an anchor, its authorization resource must be the subject; with an anchor, the anchor must carry the subject's
route and be declared by the command's live parent creation, without comparing the authorization resource to the subject.
The row stores the declared anchor, or null for an anchorless append. It returns the document `{ id, digest }` for semantic
to store as the statement value.
The semantic command emits `com.rezics.content.authored-field.created.v1` with the document, subject, candidate and author IDs
in the same transaction. Append also initializes the `content.authored_field.owner` Access role for the author at that
command's authorization time; it carries `document:erase`.
Documents are text-only until subject-field media claims exist; image and media nodes are refused.

`readAuthoredField` is a low-level exact storage read that includes erased tombstones and must never serve as a public
handler. Disclosure follows the current semantic candidate, as it does for imported documents; a document ID by itself
does not authorize disclosure.

`eraseAuthoredField` requires account admission and `document:erase` on the document at the command's authorization time.
It runs in the document's partition, clears the body and marks the row erased, while retaining its identity and digest.
Only the author receives this owner permission. A repeat succeeds without another erased event. Moderation is separate:
a harmful field document is handled by retracting its semantic statement, which ends the candidate's disclosure so its
body is no longer served.

`GET /v1/documents/{id}` serves an authored field document only while its stored semantic candidate is disclosed and
the subject passes the current `subject:read` check. Its response identifies `origin: account`, the author account and
the document licence. Erased authored documents, like missing or undisclosed documents, answer not found. The matching
`DELETE /v1/documents/{id}` requires an `Idempotency-Key` and the author's `document:erase` permission; a successful
deletion and authorized replay return 204 with the stored session position.

## Media claims

A malformed media ID list is a 400 `invalid_request`. Any well-formed reference that cannot be claimed returns the same 409 `media_unavailable` response, whether its ID is unknown, belongs to another route, container or uploader, or its media is reserved, uploaded, rejected, erased or already claimed. This response does not identify which case applied; uploaders can read their own media state through the media routes. A 422 `idempotency_conflict` is reserved for reusing an idempotency key with a different request.

## Cost

| Operation                         | Touches                                                                                                                         | Bound                                                                                                                          | Growth check                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authored document append/read     | Validate/hash <= 2 MiB; append one field and event; exact-key read.                                                             | Constant rows/statements; logarithmic blocks in documents.                                                                     | `test/content/authored-fields.test.ts`: “authored document append and read”                                                                                                                                                                                                                                                    |
| Authored document erasure         | Account admission, `document:erase` Access, one exact tombstone and first-transition event.                                     | Constant rows/statements; logarithmic blocks plus Access and command.                                                          | `test/content/authored-field-erasure.test.ts`: “authored document erasure”                                                                                                                                                                                                                                                     |
| Authored document HTTP read       | Initial/final imported/authored probes, prepared Access recheck and candidate disclosure.                                       | Constant rows/statements independent of documents.                                                                             | `test/content/authored-document-http.test.ts`: “authored document read”                                                                                                                                                                                                                                                        |
| Document read                     | Bounded candidate tuples and selected body; Accounts formula and exact tuple probes.                                            | Constant candidate rows/statements; logarithmic blocks in indexed history.                                                     | `test/content/document-http.test.ts`: “checkGrowth includes actual Accounts formula and constant exact document candidate and tuple probes”                                                                                                                                                                                    |
| Avatar summaries                  | One statement per media partition; media row and variants per ID, n <= 256.                                                     | Linear rows in n; fixed statements per partition, independent of media history.                                                | `test/content/avatar-media.test.ts`: “avatar summaries”                                                                                                                                                                                                                                                                        |
| Avatar check                      | One media primary-key read in account partition.                                                                                | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/avatar-media.test.ts`: “avatar check”                                                                                                                                                                                                                                                                            |
| Author item index                 | Guarded upsert/delete per event; erasure reads post and thread anchor; command event.                                           | Constant rows/statements; logarithmic blocks in index history.                                                                 | `test/content/author-item-index.test.ts`: “author item index”                                                                                                                                                                                                                                                                  |
| Author thread page                | Public-view point read, <= 4L author-index candidates and thread/board disclosure probes.                                       | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                              | `test/content/author-item-reads.test.ts`: “author thread page”                                                                                                                                                                                                                                                                 |
| Author post page                  | Public-view point read, <= 4L author-index candidates and post/thread disclosure probes.                                        | Linear rows/statements in L, L <= 20; logarithmic blocks and independent of account item history.                              | `test/content/author-item-reads.test.ts`: “author post page”                                                                                                                                                                                                                                                                   |
| Board projection                  | Bounded source ancestry/page; fixed candidate/change set in destination command.                                                | Constant rows/statements; logarithmic blocks at fixed page/change set.                                                         | `test/content/growth-boards.test.ts`: “Board projection stays within its bound as T grows”                                                                                                                                                                                                                                     |
| Board candidate page              | Keyset-read at most d created-at candidates; active rank uses separate rank index.                                              | Constant rows/statements and logarithmic blocks for fixed d; ascending growth is not captured.                                 | `test/content/growth-boards.test.ts`: “Board candidate page stays within its bound as d grows”                                                                                                                                                                                                                                 |
| Board pages (newest, active, hot) | Board point read, <= 200 candidates and bounded thread/board/Realm disclosure; result <= 100.                                   | Constant rows/statements for fixed page/chain; logarithmic indexed blocks.                                                     | `test/content/boards-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”, `test/content/board-hot-http.test.ts`: “the hot page stays within its bound as boards and threads grow”, `test/content/board-ranking.test.ts`: “active board pages keep constant cost as boards and threads grow” |
| Board rank refresh                | Lock <= 500 candidates; per-partition totals/Realm weights, then batch update.                                                  | Linear B rows with logarithmic blocks in R, <= 2B + 2 statements (B <= 500); independent of reactions/thread.                  | `test/content/board-hot-refresh.test.ts`: “one refresh batch stays within its bound as candidates and reactions grow”                                                                                                                                                                                                          |
| Collection selection              | Select eligible media through bounded indexed page, limit 100.                                                                  | Constant rows/statements for fixed page; logarithmic blocks in media history.                                                  | `test/content/growth-media.test.ts`: “Collection selection stays within its bound as P grows”                                                                                                                                                                                                                                  |
| Collection per object             | Read and update one selected object and bounded state.                                                                          | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Collection per object stays within its bound as u grows”                                                                                                                                                                                                                                 |
| Cover reference read/claim        | Exact media probes and bounded cover-reference writes.                                                                          | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Cover reference read and claim stays within its bound as u grows”                                                                                                                                                                                                                        |
| Thread creation with first post   | Validate bounded board/Realm ancestry; insert thread/post/revision/indexes, Access and command.                                 | Constant rows/statements; logarithmic blocks in indexed history.                                                               | `test/content/growth-threads.test.ts`: “Thread creation with first post stays within its bound as T grows”                                                                                                                                                                                                                     |
| Review creation                   | Board validation; thread/post/revision writes, live-review probe, Access and command.                                           | Constant rows/statements; logarithmic blocks, independent of board review count.                                               | `test/content/growth-threads.test.ts`: “Review creation stays within its bound as the reviews board grows”                                                                                                                                                                                                                     |
| Reply                             | Validate <= 32 parent posts and bounded ancestry; insert post/revision/indexes.                                                 | Constant rows/statements; logarithmic blocks, independent of post count.                                                       | `test/content/growth-threads.test.ts`: “Reply stays within its bound as p grows”                                                                                                                                                                                                                                               |
| Post edit                         | Read target/head and bounded chain; insert revision and update head.                                                            | Constant rows/statements; logarithmic blocks, independent of revision history.                                                 | `test/content/growth-threads.test.ts`: “Post edit (new revision) stays within its bound as r grows”                                                                                                                                                                                                                            |
| Thread read                       | Exact thread/board and bounded container disclosure; no revision-history walk.                                                  | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-threads.test.ts`: “Thread read stays within its bound as T grows”                                                                                                                                                                                                                                         |
| Post read                         | Exact post/head and bounded thread/board disclosure; load selected bounded body only.                                           | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-threads.test.ts`: “Post read stays within its bound as T grows”                                                                                                                                                                                                                                           |
| Revision read                     | Exact composite revision key and bounded disclosure chain.                                                                      | Constant rows/statements; logarithmic blocks, independent of revision history.                                                 | `test/content/growth-threads.test.ts`: “Revision read stays within its bound as T grows”                                                                                                                                                                                                                                       |
| Post keyset page                  | <= s + 1 identities (s <= 200), bounded disclosure; public page <= 100.                                                         | Linear rows in fixed s; constant statements, logarithmic blocks; no older-history walk.                                        | `test/content/growth-threads.test.ts`: “Post keyset page stays within its bound as p grows”                                                                                                                                                                                                                                    |
| Revision keyset page              | <= s + 1 identities (s <= 200); full enumeration costs O(r) across pages.                                                       | Linear rows in fixed s; constant statements, logarithmic blocks.                                                               | `test/content/growth-threads.test.ts`: “Revision keyset page stays within its bound as r grows”                                                                                                                                                                                                                                |
| Public board read                 | Exact board key and current disclosure state.                                                                                   | Constant rows/statements; logarithmic blocks in thread history.                                                                | `test/content/growth-threads.test.ts`: “Public board read stays within its bound as T grows”                                                                                                                                                                                                                                   |
| Subject thread page               | Bounded subject-thread index page and candidate disclosure.                                                                     | Linear rows in fixed page size; constant statements and logarithmic blocks.                                                    | `test/content/growth-subject-threads.test.ts`: “subject thread page stays within its bound as the subject thread index grows”                                                                                                                                                                                                  |
| Subject thread index projection   | Write one subject-thread index entry per thread event.                                                                          | Constant rows/statements; logarithmic blocks as other threads grow.                                                            | `test/content/subject-thread-index.test.ts`: “indexing one thread has constant rows and statements and logarithmic blocks as other threads grow”                                                                                                                                                                               |
| Author erasure request            | Admission snapshot, provenance and operation row; command and workflow binding.                                                 | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/erasure-initiation-provenance.test.ts`: “initiation keeps its wire, admission and one-attempt cost; the growth check holds at three scales”                                                                                                                                                                      |
| Author erasure binding/status     | Point-read/write workflow identity and operation status.                                                                        | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-lifecycle.test.ts`: “Author erasure binding and status stays within its bound as P grows”                                                                                                                                                                                                                 |
| Native author erasure             | Fixed posts/revisions/media page and operation/initiator reads; count only page revision identities.                            | Constant rows/statements per page; linear rows in affected k revisions; logarithmic blocks.                                    | `test/content/erasure-workflow.test.ts`: “native content erasure pages”; “affected erasure revisions”; “native logical author page”                                                                                                                                                                                            |
| Author post deletion/cleanup      | One tombstone command; clear revisions in bounded pages, only affected keys.                                                    | Constant rows/statements per command/page; linear in affected revisions across pages.                                          | `test/content/author-post-delete.test.ts`: “delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow”                                                                                                                                                                                     |
| Thread/post takedown              | Read/write target/security revision and bounded projection; command event.                                                      | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/moderation-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                |
| Report storage                    | Insert one report and its event through the report-home command.                                                                | Constant rows/statements; logarithmic blocks in report and command history.                                                    | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report read and target listing    | Exact report read; target-index keyset page and selected report rows, bounded by the fixed page limit.                          | Constant rows/statements for a point read; linear rows in page limit for listing; logarithmic blocks in indexed history.       | `test/content/reports.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                        |
| Report inspection HTTP admission  | Authenticate and read the target partition, Access grant and report state for each inspection request.                          | Constant rows/statements; logarithmic blocks in grant and report history.                                                      | `test/content/reports-http.test.ts`: “checkGrowth proves constant report HTTP work with unrelated and hot-partition growth at three scales”                                                                                                                                                                                    |
| Report effect projection          | Read one committed report source reference and run one target-partition reverse-index command.                                  | Constant rows/statements per report event; logarithmic blocks in source and target histories.                                  | Missing: no native projection growth check covers source and target history.                                                                                                                                                                                                                                                   |
| Thread/post reaction slot         | Actor-target slot read/update and command; post targets add bounded ancestry. Current check measures thread set at 64/512/4096. | Constant rows/statements, logarithmic blocks for measured set branch; known defect, owner fix pending for clear/post branches. | `test/content/growth-reactions.test.ts`: “Reaction slot”                                                                                                                                                                                                                                                                       |
| Subject reaction slot             | Global `reaction:set` key probe and actor-subject slot read/update; current slot check measures set only.                       | Constant rows/statements; logarithmic blocks in Global grants for set; clear bound pending.                                    | `test/content/growth-reactions.test.ts`: “Subject reaction slot”; `test/content/subject-reaction-standing.test.ts`: “a subject reaction's Global standing probe stays within its bound as Global grants to other accounts grow”                                                                                                |
| Reaction count aggregation        | Apply fixed event changes to totals and relay projections.                                                                      | Constant rows/statements for fixed changes; logarithmic blocks.                                                                | `test/content/reaction-projection.test.ts`: “aggregation cost is O(changes) as reactions and targets grow”                                                                                                                                                                                                                     |
| Reaction count read               | `reaction-projection.readReactionCounts` reads <= 7 totals/target; page <= 7L rows per partition for L targets.                 | Linear rows in fixed L; constant statements per partition, independent of contributors.                                        | `test/content/subject-reactions-http.test.ts`: “subject reaction read”                                                                                                                                                                                                                                                         |
| Subject reaction count batch      | One statement/target partition for <= 100 IDs; <= 5 totals/ID.                                                                  | O(n) rows, n <= 100; constant statements per partition, independent of reactors.                                               | `test/content/subject-reactions-http.test.ts`: “batched subject reaction counts”                                                                                                                                                                                                                                               |
| Subject own reaction read         | Subject visibility/redirect/Access then caller-home slot read; no reactor scan.                                                 | Constant rows/statements at fixed target; logarithmic blocks.                                                                  | `test/content/subject-reactions-http.test.ts`: “subject own reaction read”                                                                                                                                                                                                                                                     |
| Subject reaction merge            | Process one page of source slots and update target slots/count events.                                                          | Constant rows/statements per fixed page; linear in changed slots across pages.                                                 | `test/content/subject-reaction-merge.test.ts`: “one merge page”                                                                                                                                                                                                                                                                |
| Realm board listing               | Keyset-read boards and native Realm/member/grant disclosure.                                                                    | Linear rows in fixed limit; constant statements and logarithmic blocks.                                                        | `test/content/realm-boards.test.ts`: “Realm board keyset listing stays bounded as other Realms add boards”                                                                                                                                                                                                                     |
| Protected Realm thread read       | Resolve membership/access and disclose bounded thread ancestry.                                                                 | Constant rows/statements for fixed ancestry; logarithmic blocks in grant/member/board history.                                 | `test/content/realm-boards.test.ts`: “Protected Realm member thread read”                                                                                                                                                                                                                                                      |
| Global board creation             | Read Concept type, read authority and Global anchor; insert the board, grants and command state in the Concept partition.       | O(1) statements and rows, independent of boards, Concepts and threads.                                                         | `test/content/global-board-create-http.test.ts`: “a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them”                                                                                                                                               |
| Concept board creation            | Read concept/Realm and insert board with Access and command state.                                                              | Constant rows/statements; logarithmic blocks; known defect, owner fix pending.                                                 | `test/content/growth-boards.test.ts`: “Concept board creation stays within its bound as boards grow”                                                                                                                                                                                                                           |
| Realm board point read            | Resolve one board by its Realm/concept keys.                                                                                    | Constant rows/statements; logarithmic blocks in board history.                                                                 | Missing: no native growth check covers this point read.                                                                                                                                                                                                                                                                        |
| Media reserve                     | Validate bounded ancestry; read/write reservation/object keys, Access and command.                                              | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Media reserve stays within its bound as u grows”                                                                                                                                                                                                                                         |
| Media complete                    | Read reservation and write completion state for one upload.                                                                     | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Media complete stays within its bound as u grows”                                                                                                                                                                                                                                        |
| Media reservation/state reads     | Exact reservation/state/fence key probes.                                                                                       | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Media reservation and state reads stays within its bound as u grows”                                                                                                                                                                                                                     |
| Post media claim                  | Read bounded post/revision ancestry and claim one media object.                                                                 | Constant rows/statements; logarithmic blocks in revision history.                                                              | `test/content/growth-media.test.ts`: “Post media claim stays within its bound as r grows”                                                                                                                                                                                                                                      |
| Image publication                 | Read bounded job/object state and publish at most twelve variants.                                                              | Constant rows/statements for fixed input; logarithmic blocks in uploader history.                                              | `test/content/growth-media.test.ts`: “Image publication stays within its bound as u grows”                                                                                                                                                                                                                                     |
| Imported image processing         | Read source fence then checkout selected media; publish bounded variants.                                                       | Constant rows/statements; logarithmic blocks in uploader history.                                                              | `test/content/growth-media.test.ts`: “Imported image processing stays within its bound as u grows”                                                                                                                                                                                                                             |
| Imported document append/read     | Append/read exact imported-field key with bounded metadata.                                                                     | Constant rows/statements; logarithmic blocks in partition history.                                                             | `test/content/growth-lifecycle.test.ts`: “Imported document append and read stays within its bound as P grows”                                                                                                                                                                                                                 |
| Source fence check                | Read fixed source-fence keys for requested page.                                                                                | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-media.test.ts`: “Source fence check stays within its bound as P grows”                                                                                                                                                                                                                                    |
| Source fence takedown             | Update one fence and emit one command event.                                                                                    | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-lifecycle.test.ts`: “Source fence takedown stays within its bound as T grows”                                                                                                                                                                                                                             |
| Media takedown                    | Read/update selected moderation state by exact keys.                                                                            | Constant rows/statements; logarithmic blocks in media history.                                                                 | `test/content/media-moderation.test.ts`: “checkGrowth with actual formula across three informative scales and no content sequential scan”                                                                                                                                                                                      |
| Standalone media erasure          | Tombstone selected media and emit media-erased event.                                                                           | Constant rows/statements; logarithmic blocks.                                                                                  | `test/content/growth-media-erase.test.ts`: “Erase media stays within its bound as M grows”                                                                                                                                                                                                                                     |
| Media download decision           | Validate exact original/variant and recheck current post/container chain and board.                                             | Constant rows/statements for bounded ancestry; logarithmic blocks.                                                             | `test/content/media-http.test.ts`: “checkGrowth proves the declared three-scale machine-independent bound”                                                                                                                                                                                                                     |
| Committed media purge             | Read partition/media keys, delete only committed erased prefix; R2 listing/key quotas apply.                                    | Constant SQL rows/statements; logarithmic blocks; R2 <= 10,000 pages and 100,000 keys.                                         | `test/content/growth-lifecycle.test.ts`: “Committed media purge stays within its bound as T grows”                                                                                                                                                                                                                             |
| Sitemap board/thread feeds        | Keyset boards and bounded newest-first thread probes/disclosure; L <= 1000 and 200 thread candidates/probe.                     | O(L log N) rows and constant statements per fixed-L page.                                                                      | `test/content/growth-sitemap.test.ts`: “${feed} sitemap page stays within its bound as listed items grow”                                                                                                                                                                                                                      |
| Durable content work              | Enqueue/status and registered steps; collection check includes actual Delta linearity.                                          | Constant rows/statements for fixed payload/page; linear only in changed collection objects.                                    | `test/content/work.test.ts`: “checkGrowth proves bounded real collection SQL with same-partition distractors at three scales”                                                                                                                                                                                                  |
| Source fence HTTP routes          | Validate two independent roots, tuple-home snapshot and final authentication.                                                   | Constant rows/statements for fixed ancestry; logarithmic blocks in same-source partition rows.                                 | `test/content/source-fence-http.test.ts`: “checkGrowth keeps actual HTTP authorization and exact tuple cost bounded amid same-source partition rows”                                                                                                                                                                           |

Content setup writes one installation marker and one Global `reaction:set` grant once. The Global grant growth
check uses scales [256, 1024, 4096] with the series rule.

Derivations use the implemented adapters and SQL in `db/content/migrations/` and `db/content/schema.sql`. At fixed admitted input, unique-key B-tree probes examine constant rows and use O(log N) shared blocks; changing k indexed rows uses O(k log N) blocks. Rows include filtered candidates; blocks include bounded body access but exclude dead tuples, vacuum debt and lock waits. `C` is the command envelope (receipt/partition/outbox and bounded write-basis inserts), adding constant rows/statements and logarithmic blocks. `A` is an authenticated Access check, derived in [Access Cost](../access/README.md#cost). Transactions, settings, catalogue checks and time reads add fixed statement constants. Body and metadata byte caps bound read/write bytes.

Limits: board candidates <= 200, collection <= 100, public pages <= 100 results with at most 200 hydrated candidates. Post/revision candidate helpers cap s at 200 and fetch s + 1 identities. Reply validation checks at most 32 parent posts; edit at most 33. Rank refresh locks <= 500 candidates. Sitemap pages cap L at 1000. Media input is <= 20 MiB / 40 million decoded pixels, with at most twelve variants. Reaction slot growth scales are [64, 512, 4096]. The `subject-reactions-http` “subject reaction read” capture covers `reaction-projection.readReactionCounts`.

### Appeals

- **Touches:** Appeal reads one decision and inserts one appeal row. Resolve updates one appeal row and checks target authorization, plus `liftTakedown`'s bound and one notice. Pending lists follow the report list bound: at most L + 1 queue candidates and L independently authorized source reads, with L <= 100. Board candidates are projected from committed events on the board route; a resolution permanently removes the candidate from its pending index.
- **Bound:** Constant rows per appeal and resolution; O(L) rows and statements per list, independent of appeals per board.
- **Growth check:** `test/content/appeals-http.test.ts`, `appeals per board`, at 64, 256 and 1024 appeals; rows per call stay constant.
