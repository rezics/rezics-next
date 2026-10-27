# Content

Content owns boards, threads, posts, immutable documents, media state and publication, and content governance operations.

A `BoardView` includes `realmId`, which is the containing Realm id or `null` for a board without a Realm. The field is
output-only and comes from the board row used for disclosure.

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

The inbox is private to its account. Naming another account returns 404 for list, count and mark seen. Route
spelling follows the content routes' conventions and is left to implementation. The GET list returns newest
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
`invalid_cursor`. The position is AES-256-GCM encrypted inside the signed cursor, with a separate HMAC-derived
key per feed. Skipped candidates reveal no identity, route or creation time. Other feeds can reuse
`sealSitemapPosition` and `openSitemapPosition`, supplying their own encryption purpose and validating the opened
position.

Every caller gets the same bytes. A feed evaluates as the anonymous reader even when the request carries a bearer, and
lists exactly what an anonymous reader can open:

- **Boards:** published and not taken down, with no Realm or a public Realm, and with at least one listed thread. An empty board is a thin page and is not listed.
- **Threads:** published and available, on a listed board, passing the thread disclosure of the anonymous
  `listBoardThreads` page (the shared `discloseThreads`), with an available opening post.
- Nothing under a protected Realm or a removed board, and no draft, protected, taken-down or erased thread, is listed.

Keyset order uses immutable keys: boards by `(route, board_id)`, and threads board by board through
`board_thread_page_idx` by `(created_at, thread_id)`. A walk lists every item that stays listed for the whole walk
exactly once. Threads under protected Realms and removed boards are never read. The board feed probes threads
newest first and resumes an unfinished probe on the next page, so any number of newer hidden candidates cannot
make a board with a listed thread disappear.

A page examines at most 4 × `limit` candidate rows. When it reaches that cap it returns what it found with a non-null
`next`, possibly with no items; clients follow `next` until it is `null`.

`lastModified` is the last significant change of what the page shows, from columns the write paths already maintain:
for a thread `board_thread.last_activity_at`; for a board its newest listed thread's `created_at` (or its own
`created_at` if there is none, though thin boards are omitted). Post edits and
removals do not advance it, and no feed adds a write-path update, index or migration.

## Reactions

People have one reaction slot per thread, post or subject. Threads and posts accept upvote, downvote, like, love, laugh,
insightful and sad. Subjects accept like, love, laugh, insightful and sad; their semantic score remains the subject's
rating. Subject reactions require the actor to be admitted and hold `reaction:set`, then require the subject to be
readable at the same authorization time as a subject read. Unknown or unreadable subjects return not found. A merged
subject id resolves to its survivor, and the slot is written on that survivor. Subjects have no board, Realm
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

### Cost

#### Subject reaction merge page

- **Touches:** At most 100 reactor IDs in the merged subject's partition; at most 100 actor commands, each with a
  constant number of statements in one actor partition; at most two reaction change events per actor.
- **Bound:** O(100) commands and rows per page; `ceil(R / 100)` actor pages for R reactors, plus an empty cursor check
  when R is an exact multiple of 100. Page work is independent of R.
- **Growth check:** `test/content/subject-reaction-merge.test.ts`, `one merge page`, at 256, 1024 and 4096 reactors on
  the merged subject. Rows and statements per page stay constant.

### Cost

#### Subject reaction slot

- Touches: account admission; one subject readability probe in the subject's partition; one slot upsert or delete in the actor's partition; at most one change event.
- Bound: constant rows and statements. Blocks O(log R) in the actor's partition.
- Growth check: `test/content/growth-reactions.test.ts`, `Subject reaction slot`, at 64, 512 and 4096 reactions on the subject.

#### Subject reaction relay

- Touches: one contribution upsert, at most two total upserts, and one reactor upsert or delete, all in the subject's partition in one transaction.
- Bound: constant statements. Blocks O(log R).
- Growth check: `test/content/growth-reactions.test.ts`, `Subject reaction relay`, at 64, 512 and 4096 reactors.

## Covers

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

## Authored field documents

An authored field document stores the editor's canonical document body, SPDX licence and BCP 47 language in
`content.authored_field`, beside the subject's route. Its row binds the body to the semantic subject, candidate and
revision, and records the acting account as `author_account_id`. `appendAuthoredField` runs only inside the current
authorized subject command and returns the document `{ id, digest }` for semantic to store as the statement value.
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

## Cost

### Authored field document append and read

- **Touches:** Validate and hash at most 2 MiB of canonical document bytes; insert one authored-field row by primary key in the subject's partition and emit one event in the caller's command. `readAuthoredField` performs one exact primary-key read, including tombstones.
- **Bound:** Constant rows and statements; O(log D) blocks in the partition, where D is its authored document count.
- **Growth check:** `test/content/authored-fields.test.ts`, `authored document append and read` at 64, 512 and 4096 documents in the partition. Rows and statements stay constant.

### Authored document read

- **Touches:** For each initial and final subject snapshot, one exact imported-field probe followed by one exact authored-field probe when no import exists; one prepared subject Access check, rechecked on both passes; and one candidate disclosure read on each pass. All document, Access and disclosure probes are in the subject's partition. Authored reads skip the source-fence lookup because they have no source.
- **Bound:** Constant rows and statements, independent of the partition's documents.
- **Growth check:** `test/content/authored-document-http.test.ts`, `authored document read` at 64, 512 and 4096 documents in the partition. Rows and statements stay constant.

### Authored document erasure

- **Touches:** Account admission and one `document:erase` Access check at T; one exact-key statement updates the
  document to a bodyless tombstone and recognizes an existing tombstone; one erased event on the first transition.
- **Bound:** Constant rows and statements; O(log D) blocks for D authored documents in the partition, plus A and C.
- **Growth check:** `test/content/authored-field-erasure.test.ts`, `authored document erasure` at 64, 512 and 4096
  documents in the partition. Rows and statements stay constant.

These are derivations from the implemented adapters and SQL here, checked against `db/content/migrations/` and `db/content/schema.sql`, not measurements or promises about a particular query plan.
`T` is total threads, `P` rows in an anchor's partition, `p` posts in one thread, `r` revisions of one post, `t` threads in one board, `d` page depth, `s` requested results and `k` changed rows; `u` is one uploader's media history.
`L(N) = O(log(2 + N))` shared blocks for a B-tree probe, examining constant rows for a unique key; changing `k` indexed rows costs `O(k L(N))` blocks, not a scan of the containing history.
Below, `L(P)` denotes a home-local index's depth; the current schema uses shared, route-leading B-trees rather than physical partition tables, so their actual depth is logarithmic in the whole indexed relation, including other partitions (for `thread`, `L(T)`).
Rows mean logical index/heap candidates, including filtered candidates; block bounds include heap/body access with fixed byte limits, but exclude obsolete tuples, vacuum debt and lock waiting.
All content relations below use the `content` schema; `PK` means the named relation's `_pkey`, and rows stated as one include the missing-row case.
SQL counts are adapter data statements per attempt; typed `.run` calls can additionally check the fixed schema catalogue, and transaction, settings and time statements add constants.

`C` denotes one successful `runCommand` envelope: one exact `core.receipt` primary-key read when supplied, one `core.partition` primary-key counter update, one `core.outbox` event insert for each operation below, at most one `editorial.write_basis` insert and one receipt insert, all at the command partition and through their primary keys.
Thus `C` adds constant rows/statements and logarithmic indexed blocks; replay authorizes and reads the receipt but skips the body and new event, while unchanged jobs roll back without an event.
Contention retries stop after three; fenced-partition polling and remote retries depend on deadlines/availability, not stored content cardinality.
`A` denotes an authenticated Access check; its rows, statements and blocks are derived in [Access Cost](../access/README.md#cost), and table entries retain `+A` explicitly.
Exact-key temporal GiST probes and `WITHOUT OVERLAPS` exclusion checks count as logarithmic: at a given time an exact key matches at most one interval, GiST is height-balanced, and growth checks guard against the lack of a worst-case guarantee.
Imported-document and cover hooks consume their caller's existing authorization; their storage reads alone never grant disclosure, and the public caller must separately check current semantic authority and source fences.

Board candidates cap `s` at 200 and collection caps it at 100. Post and revision candidate helpers cap `s` at 200 and fetch `s + 1` identities; public pages return at most 100 results and hydrate at most 200 candidates. Accumulated `p` and `r` remain uncapped; enumerating all history still visits O(r) revisions across pages.

### Avatar summaries

- **Touches:** One statement per media partition among the ids; at most one media row plus its variants per id.
- **Bound:** O(n) rows for n <= 256 ids, independent of the partition's media count.
- **Growth check:** `test/content/avatar-media.test.ts`, `avatar summaries`: 64, 512 and 4096 media per partition
  with 256 ids. Rows and statements stay constant.

### Avatar check

- **Touches:** One media primary-key read in the account's partition.
- **Bound:** Constant rows and statements.
- **Growth check:** `test/content/avatar-media.test.ts`, `avatar check`: 64, 512 and 4096 media in the partition.

### Review creation

- **Touches:** The board's partition for the existing validation read, then only the author's partition: one
  thread, one post, one revision, an optional vote primary-key read and the live-review index probe, plus A+C.
- **Bound:** Constant statements and rows; O(log N) blocks in the author's partition, independent of how many
  reviews the board or subject has. Thread insert and update guards read no table.
- **Growth check:** `test/content/growth-threads.test.ts`, `Review creation stays within its bound as the reviews board grows`:
  256, 1024 and 4096 reviews, seeded set-based at their authors' routes, with a spare review for each scale's warm-up.

### Author item index

- **Touches:** One guarded upsert or delete in the author's partition per event, plus C. Erasure adds one post primary-key read and its partition anchor in the thread's partition, released first.
- **Bound:** Constant rows and statements. Blocks O(log I) for I items by the author, plus logarithmic command and source primary-key probes. The route-leading primary key and read index never scan the author's history.
- **Growth check:** `test/content/author-item-index.test.ts`, `author item index` at 64, 512 and 4096 items by the author. Thread creation, reply creation and erasure keep rows and statements constant; each scale warms on spare probes.

### Hot board page

- **Touches:** One keyset seek of L `board_thread` rows by `(route, board_id, hot_rank DESC, thread_id)`, plus the existing final disclosure per item.
- **Bound:** O(L × (conditions + chain)), as the active page.
- **Growth check:** `test/content/board-hot-http.test.ts`, `Hot board page`: a fixed page with constant rows and statements as board threads grow.

`document.ts` and both document tables cap canonical bodies at 2 MiB, with at most 128 subject references and 32 media IDs per revision; document validation, hashing and text extraction are linear in those bounded bytes.
Images cap input at 20 MiB and decoding at 40 million pixels, generating at most twelve variants; `media_variant_slot_idx` enforces twelve slots even for sub-320 widths.

Thread, board, licence, attribution, and import-evidence metadata have database-enforced character and UTF-8 byte caps, so their contribution to each content operation is constant.
Writes to Realm-owned content preserve the Realm's read boundary: if the actor cannot read the Realm, thread creation, replies, revisions, reactions and reports return the same unknown-equivalent `not_found` response, including its problem body and headers. Participation-gated writes check `realm:participate` and, for a protected Realm, `realm:read` at the command's T. A readable Realm that denies participation, such as a public Realm with a ban, still returns `forbidden`. Adding the actor as a protected Realm member enables the same writes.
Command containment preparation and validation use exact thread/post/head-revision probes, rejecting cycles and overlong chains: reply checks at most 32 parent posts, edit at most 33 including the target. Preparation releases the thread snapshot before independently reading the board; parent authorization and command validation repeat the bounded chain. Creator initialization reads each new identity once, then writes one `access.resource_initialization` PK and the fixed owner/standing `access.resource_role_grant` temporal keys per resource (two grants each for thread/post, one for media).
Exact disclosure in `reads.ts` observes and rechecks one thread, at most 33 posts and their heads, and one selected revision; it independently discloses the board between thread snapshots. Each `read-chain.sql` point statement uses thread/board/post/revision PKs and the head's `revision_route_thread_id_post_id_revision_id_key`. Eligibility rechecks each container once; only after authorization is one selected revision's bounded body loaded. Realm-owned threads and posts also bind and recheck their containing Realm, then run at most one `realm:read` Access check for the disclosure at T, regardless of the post count. This is at most 120 data statements per disclosure, including partition reads and eligibility points, plus a fixed number of A checks (at most 35); it never walks revision history. The storage-only `read-revision.sql` is one exact composite-unique probe, not the public disclosure operation.
The `insert-thread.sql`, `insert-post.sql` and `insert-revision.sql` storage helpers each insert one row in one statement; public commands use their `create-*.sql` counterparts, with the same primary/unique keys and exact foreign-key checks. Post inserts maintain `post_thread_page_idx` and `post_thread_author_page_idx`; revision inserts maintain `revision_post_page_idx`. Creation commands do not count or rewrite existing posts/revisions.

| Operation                         | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Bound                                                                                                                                                                                                                  | Growth check                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board projection                  | `createBoardEffect` reads one source `core.partition` (PK) and one `thread` (PK) in a released source snapshot, then upserts one `board_thread` by PK in the board partition, maintains `board_thread_page_idx`, and emits one projected event through `C`; 3 data statements plus `C`, no board count. `applyBoardCandidate` uses just the destination upsert plus `C`. Grow total T and both anchor partitions, fixing the event and board.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rows O(1); blocks O(L(T) + L(P)); statements O(1). Stale watermarks change zero rows.                                                                                                                                  | `test/content/growth-boards.test.ts`: `Board projection stays within its bound as T grows`                                                                                                                                                                              |
| Board candidate page              | Snapshot reads one `core.partition` (PK), then up to s `board_thread` rows through `board_thread_page_idx(route,board_id,created_at,thread_id)`; 2 data statements, board partition, either index direction, no writes or thread join. Grow t, d, total T and board-partition P; fix s and the cursor neighbourhood.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows O(s); blocks O(L(P) + s); statements O(1), independent of d and linear in s only. Candidate facts are not the unfinished public board disclosure path.                                                            | `test/content/growth-boards.test.ts`: `Board candidate page stays within its bound as d grows`                                                                                                                                                                          |
| Media reserve                     | Container reservations prepare and validate at most 33 posts plus thread and board: one `read-media.sql` statement per hop, `post`/`thread`/`board` PKs and one exact head `revision` composite unique key per post. For `newThread`, prepare `thread:create` and `media:create` on the board chain at T, then read the deterministic target once by `thread` PK in its home partition; an existing row returns 409 before the reservation write. Insert one `media` (PK, unique route/key and route/uploader/request keys), re-read its creation provenance, insert one `access.resource_initialization` and one creator `resource_role_grant` via their keys, then `C`. The new-thread path adds one thread PK point read to today's constant reservation work and one board-anchored A for `thread:create`. Grow total, anchor P, p and u; fix ancestry, actor and request. | Content rows/statements O(1), blocks O(L(P)); container +A, newThread +A and O(L(T)) for the thread PK point read.                                                                                                     | `test/content/growth-media.test.ts`: `Media reserve stays within its bound as u grows`; `test/content/new-thread-media.test.ts`: `new-thread reservation stays bounded as other uploaders add same-route media rows`                                                    |
| Media complete                    | `media:complete` A, one media PK read with up to 12 `media_variant` rows by PK prefix, one media PK update from reserved to uploaded, one uploaded event via C; 2 data statements plus A+C, media/container partition. Grow total, anchor P and u; fix object, variants and request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Content rows O(1), blocks O(L(P)), statements O(1); +A.                                                                                                                                                                | `test/content/growth-media.test.ts`: `Media complete stays within its bound as u grows`                                                                                                                                                                                 |
| Media reservation and state reads | `readReservation`, `readMediaState`, `readCollectionFence`: one media PK lookup, aggregate at most 12 variants by `media_variant_pkey` prefix; 1 data statement at media route, no writes. Reservation additionally checks uploader and media:read_reservation through A; state/fence helpers are internal facts. Grow total, anchor P and u; fix object/variants/actor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Internal facts: rows/statements O(1), blocks O(L(P)); reservation +A.                                                                                                                                                  | `test/content/growth-media.test.ts`: `Media reservation and state reads stays within its bound as u grows`                                                                                                                                                              |
| Post media claim                  | `claim-media.sql`: 1 statement in the existing authorized post command partition, lock/read/update k <= 32 media by PK; validate one post PK and one revision PK (at most once per media), no history scan; caller supplies C and event. Grow total, anchor P, p, r and u; fix k and referenced post/revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rows O(k), blocks O(k L(P)), statements O(1); zero SQL for an empty claim. No additional Access formula.                                                                                                               | `test/content/growth-media.test.ts`: `Post media claim stays within its bound as r grows`                                                                                                                                                                               |
| Cover reference read and claim    | `checkMediaObject`: 1 exact media read via `media_cover_reference_idx` or PK, one row; `claimCoverMedia`: 1 statement joins `unnest(media_ids)` to `content.media` by `(route, media_id)`, reading/updating k <= 32 exact media PKs in the subject's existing authorized command partition, validates stored rights/provenance and current command identity. No independent events/grants; caller supplies them. Grow total, anchor P and u; fix references and k.                                                                                                                                                                                                                                                                                                                                                                                                             | Read rows O(1), claim rows O(k); blocks O(L(P)) / O(k log N); statements O(1). No scan of uploader or candidate history.                                                                                               | `test/content/growth-media.test.ts`: `Cover reference read and claim stays within its bound as u grows`                                                                                                                                                                 |
| Image publication                 | `lock-media.sql` reads/locks one media PK and <=12 variants by PK prefix; `finish-image.sql` updates one media PK, inserts <=12 variants (PK, unique route/key, slot index), each FK probes media PK; 2 data statements plus C at media partition. One original GET and <=12 deterministic PUTs, rejection purges only its prefix. Grow total, anchor P and u; fix object bytes/pixels and variants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rows O(k), k <= 13; blocks O(k L(P)); statements O(1). Transform CPU/bytes bounded per object, not by u.                                                                                                               | `test/content/growth-media.test.ts`: `Image publication stays within its bound as u grows`                                                                                                                                                                              |
| Collection selection              | `select-collectable-media.sql`: 16 statements, two seeks each, across exactly 16 routes of one partition, <=32s media candidates through `media_collection_eligible_idx` and `media_collection_pending_idx`; host merges/sorts <=32s and keeps s. Pending implies unclaimed and not erased by CHECK constraints, so no unbounded residual filtering. Grow total, anchor P and u; fix s and oldest eligible neighbourhood.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Rows O(s), blocks O(32 L(P) + s), statements constant 16 plus one time read; host CPU O(s log(2+s)), s <= 100.                                                                                                         | `test/content/growth-media.test.ts`: `Collection selection stays within its bound as P grows`                                                                                                                                                                           |
| Collection per object             | Fence one media PK through `fence-collection.sql` + C; release, delete only `m/id/`, then delete one media PK through `finish-collection.sql` + C, cascading <=12 variants through PK prefix. 2 data statements and 2 C, same media partition; one event per phase, no account/uploader scan. Grow total, anchor P and u; fix object prefix/variants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rows O(k), k <= 13 plus constant envelopes; blocks O(k L(P)); statements O(1). R2 prefix listing/deletion is bounded to this object's keys, not u.                                                                     | `test/content/growth-media.test.ts`: `Collection per object stays within its bound as u grows`                                                                                                                                                                          |
| Imported image processing         | `processImportedMedia` prepares one locked media PK read plus partition PK, releases; separately reads source-home partition PK and one `source_fences` PK; releases before media command re-reads partition and media PK, then updates one media via finish-upload or rejection and C. At most 7 data statements plus C; no user Access in this trusted job. Fetch <=4 HTTPS requests, transform bounded bytes, PUT one original; rejection purges own prefix. Grow total, both anchor partitions and u; fix source/object/bytes.                                                                                                                                                                                                                                                                                                                                             | Rows O(1), blocks O(L(P)) per independently released home; statements O(1), no cross-partition transaction.                                                                                                            | `test/content/growth-media.test.ts`: `Imported image processing stays within its bound as u grows`; `test/imports/media-boundary-growth.test.ts`: `native public media and registered jobs stay bounded as hot media and unrelated history grow`, at scales 1, 8 and 64 |
| Imported document append and read | `appendImportedField` checks current subject authorization and same-route candidate, validates bounded document/evidence, inserts one `imported_field` via PK in subject partition; `readImportedField` reads one exact PK including tombstones in its caller's anchored partition. 1 statement each, no own event/grant; append participates in caller's C. Grow total and anchor P with accumulated imported documents; fix bytes, subject/candidate and exact ID.                                                                                                                                                                                                                                                                                                                                                                                                           | Rows/statements O(1), blocks O(L(P)); no history traversal. No implemented imported-document erasure adapter.                                                                                                          | `test/content/growth-lifecycle.test.ts`: `Imported document append and read stays within its bound as P grows`                                                                                                                                                          |
| Source fence check                | `readFences` deduplicates <=100 tuples and makes 1 statement, each lateral LIMIT 1 using complete `source_fences_pkey(route,source,external_id,field_group)`; all tuples must share the independently anchored source partition. No writes/catalogue lookup; empty input makes zero statements. Grow total and source-anchor P, including same-source neighbours; fix requested tuples.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rows O(s), s <= 100; blocks O(s L(P)); statements O(1), no source-prefix scan.                                                                                                                                         | `test/content/growth-media.test.ts`: `Source fence check stays within its bound as P grows`                                                                                                                                                                             |
| Author erasure request            | `beginAuthorErasure` reuses admission's account observation, reads the thread partition PK and first/last selected posts via two `post_thread_author_page_idx` prefix seeks in one statement, then A on the first affected post. Accounts capture adds at most one delegation point read when `requestedBy` is set. One operation PK insert freezes the actor, account/delegation snapshots, source digest and creation receipt/target; C commits the requested event and receipt commitment. Four data statements plus A+C, and the optional delegation seek; no p count. Grow total, anchor P and p with fixed actors, endpoints and authority.                                                                                                                                                                                                                              | Content rows/statements O(1), blocks O(L(P)); +A+C and at most O(log R) for delegation. Constant provenance columns and one receipt field.                                                                             | `test/content/erasure-initiation-provenance.test.ts`: `author erasure initiation provenance`                                                                                                                                                                            |
| Author erasure binding and status | `bindAuthorErasureWorkflow`: 1 exact operation PK update in caller-anchored operation partition, one supplied event from <=1000, no event/queue scan. `readOperation`: operation-partition PK + operation PK, separately account-partition PK + account PK and account:read A; at most one native workflow status call, no progress SQL. Grow total and operation/account-anchor P; fix operation and workflow response.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Binding rows/statements O(1), blocks O(L(P)); status content rows/statements O(1), blocks O(L(P)), +A.                                                                                                                 | `test/content/growth-lifecycle.test.ts`: `Author erasure binding and status stays within its bound as P grows`                                                                                                                                                          |
| Native author erasure             | Keyset pages of <=100 posts; one partition command restores the initiator, checks post:erase for every post at one T, then writes ordinary tombstones/events and one own receipt keyed by operation/page start. Exact revision-index counts enter progress at logical commit. All logical pages precede revision null pages (<=100), media erasure and purge. A denied page commits nothing; committed pages finish cleanup before code 7. Own receipts fence replay; cleanup changes no counters.                                                                                                                                                                                                                                                                                                                                                                             | With fixed revisions/post: O(100) rows/statements, O(100 log N) blocks per logical page, +A+C. P posts take ceil(P/100) logical steps plus cleanup pages instead of at least 2P.                                       | `test/content/erasure-workflow.test.ts`: `native content erasure pages`, `affected erasure revisions`, `native logical author page`                                                                                                                                     |
| Author post deletion and cleanup  | Request: one shared account admission, `read-erasure-scope.sql` exact post-scope read and `erase-content.sql` tombstone in the thread partition, plus A+C. No history enumeration. Cleanup: `null-erased-revisions.sql` seeks `revision_post_page_idx(route,post_id,recorded_at,revision_id)` and verifies the post tombstone by PK; each atomic statement selects and clears at most 100 revisions. Grow the author's posts and revisions while reusing the same fixed-size delete probe in one thread.                                                                                                                                                                                                                                                                                                                                                                       | Request rows/statements O(1), blocks O(log R), +A+C. Cleanup ceil(k/100) nonempty pages for k revisions, each O(100 log R); a full final page needs an empty termination probe. Per-page rows/statements are constant. | `test/content/author-post-delete.test.ts`: `delete is one bounded tombstone and cleanup runs in bounded pages as posts and revisions grow`, scales 256, 1024 and 4096 with one set-based seed method and at least one warmup.                                           |
| Thread/post takedown              | Prepare resolves the exact thread→board or post→thread→board→Realm chain from the target's own rows. The command checks `moderation:takedown` on the target at T; when denied, it rereads the target, checks its containing Realm through ordinary Access at the same T, then checks the receipt. A successful effect updates one target and emits one event through C. Board and media authorization retain their existing paths.                                                                                                                                                                                                                                                                                                                                                                                                                                             | O(1) rows/statements; target path plus at most two parent point reads and one additional A for the Realm, plus C; no scan.                                                                                             | `moderation-http.test.ts`: Realm-authorized `checkGrowth` at 32, 256 and 2048 rows; statement cap 4096                                                                                                                                                                  |
| Report admission proof            | Implemented `turnstile.ts` verifier only: no relations, indexes, SQL or partitions; one Siteverify request, <=2048-character token, <=64 KiB response and <=10-second timeout. Grow total T; fix credential/configuration and provider response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Database rows/blocks/statements zero; remote requests and bytes O(1). Report storage/effect APIs are stubs.                                                                                                            | `test/content/growth-lifecycle.test.ts`: `Report admission proof stays within its bound as T grows`                                                                                                                                                                     |
| Thread creation with first post   | `createThread`: independently read one board and its partition PK; insert one thread, one first post and one revision, using PKs and exact composite FK keys. Re-read thread/post (plus head revision) to initialize two creator resources as above. When `mediaIds` is nonempty, `claim-media.sql` locks and validates at most 32 media PKs and updates their `claimed_at` in the same thread partition; it confirms the opening post, revision and board by exact keys. 9 data statements plus one claim statement when needed, A+C; writes stay at the new thread home. Grow T and anchor P; fix board, body, metadata and at most 32 media IDs.                                                                                                                                                                                                                            | Rows O(k), k <= 32; blocks O(L(T) + L(P) + k L(R)); statements O(1), +A+C. Metadata bytes are capped.                                                                                                                  | `test/content/growth-threads.test.ts`: `Thread creation with first post stays within its bound as T grows`; `test/content/new-thread-media.test.ts`: `author reserves and uploads images for a new thread, then claims them on its opening post`                        |
| Review creation                   | Existing board validation in the board partition; thread, post, revision, optional vote PK read and `thread_one_live_review_idx` probe in the author partition, plus A+C.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Rows/statements O(1); blocks O(log N) in the author partition, independent of board or subject review count.                                                                                                           | `test/content/growth-threads.test.ts`: `Review creation stays within its bound as the reviews board grows`, at 256, 1024 and 4096 reviews.                                                                                                                              |
| Reply                             | `createPost`: prepare and twice validate one thread and <=32 parent posts/heads; independently read board/partition PKs. Optional first-post/head lookup supplies subjects. Insert one post and revision, initialize one creator resource, and claim <=32 media PKs in one `claim-media.sql` statement (exact post/revision checks, <=32 updates). At most 120 data statements plus A+C; indexes as above. Grow p, T and anchor P; fix chain, bytes and media.                                                                                                                                                                                                                                                                                                                                                                                                                 | Rows/statements O(1); blocks O(L(T) + L(P)), +A+C, independent of p. Metadata bytes are capped.                                                                                                                        | `test/content/growth-threads.test.ts`: `Reply stays within its bound as p grows`                                                                                                                                                                                        |
| Post edit (new revision)          | `revisePost`: prepare and twice validate one thread and <=33 posts/heads; independently read board/partition PKs. Insert one revision via PK/composite unique key; compare-and-update one post head via post PK, maintaining exact deferred head FK. Claim <=32 media PKs (<=32 updates) in at most 1 statement. No old revision rewrite or history scan. At most 120 data statements plus A+C; indexes as above. Grow r, T and anchor P; fix chain, bytes and media.                                                                                                                                                                                                                                                                                                                                                                                                          | Rows/statements O(1); blocks O(L(T) + L(P)), +A+C, independent of r. Metadata bytes are capped.                                                                                                                        | `test/content/growth-threads.test.ts`: `Post edit (new revision) stays within its bound as r grows`                                                                                                                                                                     |
| Thread read                       | `readThread` discloses the first post: one extra thread PK point locates it, then exact disclosure as above (one thread, <=33 posts/heads, one selected revision, board and partition PKs); no writes. A Realm-owned thread adds one containing-Realm relationship recheck and at most one `realm:read` Access check for the thread and its post chain. At most 120 data statements plus <=35 A checks, including eligibility rechecks and the final body read. Grow T and anchor P; fix first-post chain, body and metadata.                                                                                                                                                                                                                                                                                                                                                  | Rows/statements O(1); blocks O(log T + L(P)), +A. Metadata bytes are capped.                                                                                                                                           | `test/content/growth-threads.test.ts`: `Thread read stays within its bound as T grows`; `test/content/realm-boards.test.ts`: `a settled protected Realm member reads its boards, threads and posts`                                                                     |
| Post read                         | `readPost` with no revision ID discloses the exact post head through the bounded ancestor chain: one thread, <=33 post/head pairs, one selected revision and independently anchored board, all exact keys as above. A Realm-owned post adds one containing-Realm relationship recheck and at most one `realm:read` Access check for the thread and post chain. At most 120 data statements plus <=35 A checks; no writes. Grow T and anchor P; fix post, ancestors, head, body and metadata.                                                                                                                                                                                                                                                                                                                                                                                   | Rows/statements O(1); blocks O(log T + L(P)), +A. Metadata bytes are capped.                                                                                                                                           | `test/content/growth-threads.test.ts`: `Post read stays within its bound as T grows`                                                                                                                                                                                    |
| Revision read                     | `readPost` with a revision ID uses the same exact disclosure probes, then checks the selected revision belongs to the post; it reads one thread, <=33 posts/heads, one selected revision, board and partition PKs. At most 120 data statements plus <=35 A checks; no writes or traversal of r. Erased revisions return authorized tombstones without body bytes. Grow T and anchor P; fix revision/chain/bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rows/statements O(1); blocks O(L(T) + L(P)), +A, independent of r. Metadata bytes are capped.                                                                                                                          | `test/content/growth-threads.test.ts`: `Revision read stays within its bound as T grows`                                                                                                                                                                                |
| Reaction slot                     | `setReaction` / `clearReaction`: one shared account admission observation, one bounded target/ancestor eligibility query at T and independently anchored board/read Access (A), then one point upsert or delete on `(route,actor_account_id,target_id)` in the actor partition, plus at most one change event (C). Same-kind repeats and absent clears roll back without a receipt or event. Counts are relayed later into the target partition. Grow reactions, other actors and other targets; fix the probe and its container chain.                                                                                                                                                                                                                                                                                                                                        | O(1) rows and statements, O(log R) blocks plus A+C; zero sequential scans. Ancestor depth is capped at 33.                                                                                                             | `test/content/growth-reactions.test.ts`: `Reaction slot` (256, 2048, 16384 reactions)                                                                                                                                                                                   |
| Subject thread page               | `listSubjectThreads` checks the subject in one released subject-partition snapshot, then reads at most 4s `subject_thread` index rows by `(last_activity_at,thread_id)` keyset. Each candidate gets one final `readSubjectThread` disclosure of its current thread, opening post, board and place; no writes, OFFSET or count. `s <= 20`, so no page reads more than 80 candidates. Grow the subject index and its partition; fix s, subject, place, kind and cursor neighbourhood.                                                                                                                                                                                                                                                                                                                                                                                            | Rows/statements O(s) with a fixed 4x scan cap; blocks O(s (L(P) + L(T))). The scan and disclosure counts stay bounded when the subject's thread history grows.                                                         | `test/content/growth-subject-threads.test.ts`: `subject thread page stays within its bound as the subject thread index grows`                                                                                                                                           |
| Post keyset page                  | `pagePostCandidates`: 1 statement seeks `post_thread_page_idx(route,thread_id,created_at,post_id)`, <=s+1 post identities, s<=200, no writes. `listThreadPosts` anchors each seek (1 partition PK read), hydrates <=200 candidates with exact disclosure and reads the root before/after: <=200 seeks, <=400 candidate rows, <=202 disclosures (<=120 statements each plus A). Signed cursor, no OFFSET/count or unbounded filtering. Grow p and anchor P; fix cap/cursor neighbourhood/bytes.                                                                                                                                                                                                                                                                                                                                                                                 | Rows/statements O(200), blocks O(200 (L(T) + L(P))), plus capped A checks; independent of p and d. Metadata bytes are capped.                                                                                          | `test/content/growth-threads.test.ts`: `Post keyset page stays within its bound as p grows`                                                                                                                                                                             |
| Revision keyset page              | `pageRevisionCandidates`: 1 statement seeks `revision_post_page_idx(route,post_id,recorded_at,revision_id)`, <=s+1 revision identities including erased rows, s<=200, no writes. `listPostRevisions` adds <=200 partition PK reads/seeks, <=400 candidate rows and <=202 exact disclosures (<=120 statements each plus A), including initial/final post reads. Exact historical bytes are hydrated separately. Grow r and anchor P; fix cap/cursor neighbourhood/bytes.                                                                                                                                                                                                                                                                                                                                                                                                        | Rows/statements O(200), blocks O(200 (L(T) + L(P))), plus capped A checks; independent of r and d. Metadata bytes are capped.                                                                                          | `test/content/growth-threads.test.ts`: `Revision keyset page stays within its bound as r grows`                                                                                                                                                                         |
| Public board read                 | `readBoard`: two released board-home snapshots, each reading partition PK and board PK; the final Access check rechecks board eligibility. `read-chain.sql` returns `realm_id` with the same board row, and `read-board.sql` exposes it to command callers. The public BoardView path uses <=4 data statements plus A, with no writes or board-thread scan. Grow T and anchor P; fix board, authority and title bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rows/statements O(1); blocks O(L(P)), +A. Board titles are capped at 1024 characters.                                                                                                                                  | `test/content/growth-threads.test.ts`: `Public board read stays within its bound as T grows`                                                                                                                                                                            |
| URL reservation                   | `importMediaFromUrl`: twice read one source fence and partition PK in released snapshots (4 statements); two platform validations each read partition PK and semantic context PK (4); read one placement subject PK; insert one media via PK and its two unique keys; read media PK and <=1 variant via PK prefix for creator proof, then initialize one media creator resource. <=12 data statements plus A+C; no fetch or uploader scan. Grow T and anchor P; fix URL/evidence.                                                                                                                                                                                                                                                                                                                                                                                              | Rows/statements O(1); blocks O(L(P)), +A+C.                                                                                                                                                                            | `test/content/growth-lifecycle.test.ts`: `URL reservation stays within its bound as T grows`; `test/imports/media-boundary-growth.test.ts`: `native public media and registered jobs stay bounded as hot media and unrelated history grow`, at scales 1, 8 and 64       |
| URL status                        | `readMediaImportStatus`: authorize at media home, read one partition PK and one media PK; `read-media-import-status.sql` probes <=1 media_variant by PK prefix with EXISTS/LIMIT 1. Release before reading one source-home partition PK and source_fences PK. <=4 data statements plus A, no writes, URL fetch or history scan. Grow T, anchor P and u; fix media/provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rows/statements O(1); blocks O(L(P)) per released home, +A.                                                                                                                                                            | `test/content/growth-lifecycle.test.ts`: `URL status stays within its bound as T grows`; `test/imports/media-boundary-growth.test.ts`: `native public media and registered jobs stay bounded as hot media and unrelated history grow`, at scales 1, 8 and 64            |
| Source fence takedown             | `takedownSourceFence`: authority validation reads one platform partition PK and one semantic context PK, then A; one `takedown-source-fence.sql` upserts exactly one complete source_fences PK in its tuple partition, writing immutable `taken_down_at` and `takedown_id` on the first takedown, plus C. 3 data statements plus A+C; no source-prefix scan or subject fanout. Grow T and source-anchor P; fix source tuple and reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rows/statements O(1); blocks O(L(P)), +A+C.                                                                                                                                                                            | `test/content/growth-lifecycle.test.ts`: `Source fence takedown stays within its bound as T grows`                                                                                                                                                                      |
| Committed media purge             | `purgeObject`: read one partition PK and one media PK through `read-erased-media.sql`, release snapshot, then delete only m/id/ if committed erased/rejected facts permit. 2 data statements, no database writes or user Access; this trusted cleanup does not authorize standalone/post erasure. Grow T, anchor P and u; fix object keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Rows/statements O(1); blocks O(L(P)). R2 work is bounded by this prefix and the listing/key limits below, independent of u; no erasure decision is implemented.                                                        | `test/content/growth-lifecycle.test.ts`: `Committed media purge stays within its bound as T grows`                                                                                                                                                                      |

### Erase media

- **Touches:** One admission observation, one scope point read, one state write and one event in the media's partition.
- **Bound:** O(1) rows and statements; O(log M) blocks, where M is total media.
- **Growth check:** `test/content/growth-media-erase.test.ts`, `Erase media stays within its bound as M grows`: as media across other accounts grow with the probe fixed, constant rows and statements.

### Reaction count

- **Reaction count change:** Touches one contribution upsert and at most two `content.reaction_total` upserts (`-1` on the previous kind and `+1` on the new kind), in the target partition and one transaction. The source watermark changes only when its contribution row changes. Bound: O(log R) per event; concurrent changes to one target serialize on its total rows, which is acceptable for this asynchronous projection. Growth check: `test/content/reaction-totals.test.ts`, `reaction totals stay equal to contributions after actual log events are replayed, stale and reordered`; per-event rows and statements stay constant as prior contributions on the target grow.
- **Reaction counts read:** `readReactionCounts` touches one index range of at most seven total rows per target. A page reads at most L x 7 total rows per partition with one statement per partition. Bound: O(L x 7) rows, independent of contributors. Growth check: `test/content/reaction-totals.test.ts`, `single-target and page reads stay within seven rows as 256, 1024 and 4096 contributors accumulate`; one target's read and a fixed page's read stay constant as contributors on the target grow across source partitions.

- **Subject reaction counts:** `GET /v1/subjects/:id/reactions` checks subject visibility and Access, then reads at most five relayed `content.reaction_total` rows in the subject's partition. It returns the existing count array and watermark without reading the viewer's slot. Bound: O(1) rows and statements, independent of reactors. Growth check: `test/content/subject-reactions-http.test.ts`, `subject reaction read` at 64, 512 and 4096 reactors; rows and statements stay constant.
- **Subject's own reaction:** `GET /v1/subjects/:id/reaction` requires an account, checks subject visibility and Access in the subject's partition, then reads one slot by primary key in the caller's partition. The check and slot read are separate statements; the endpoint returns the caller's subject kind or null. Bound: O(1) rows and statements, independent of reactors. Growth check: `test/content/subject-reactions-http.test.ts`, `subject own reaction read` at 64, 512 and 4096 reactors; rows and statements stay constant.
- **Batched subject reaction counts:** `readSubjectReactionCounts` issues one statement per target partition and reads at most five `content.reaction_total` rows per id. Bound: O(n) rows for n <= 100 ids, independent of reactors. Growth check: `test/content/subject-reactions-http.test.ts`, `batched subject reaction counts` at 64, 512 and 4096 reactors per subject with 100 ids; rows and statements stay constant.

### Rank refresh batch

`refreshBoardRankBatch` locks at most 500 due candidates with `SKIP LOCKED`, reads per-thread reaction totals and Realm vote weights, then writes score, active rank and hot rank together. Hot rank uses thread creation time; active rank uses last activity time. New candidates begin at score 0 with both ranks computed from that score.

- **Touches:** One rank-refresh index range of at most 500 candidates, one totals statement per thread partition in the batch, one Realm-votes statement per board partition in the batch, and one batch update.
- **Bound:** O(B log R) rows with at most 2B + 2 statements for B <= 500; independent of reactions per thread.
- **Growth check:** `test/content/board-hot-refresh.test.ts`, `one hot rank refresh batch`: one batch stays constant in rows and statements as candidates grow, with reaction totals on the batch's threads.

### Sitemap board feed

- **Touches:** Keyset seeks of `content.board` by `(route, board_id)` and, for each disclosed board, a descending `board_thread_page_idx` probe with the shared thread disclosure until one is listed. Board and thread candidates total at most 4L; an encrypted cursor resumes an unfinished probe. Board and Realm checks use primary-key probes.
- **Bound:** L ≤ 1000, so O(L log N) rows and constant statements per page for a fixed L. A full walk visits boards and their bounded newest-first probes; threads under protected Realms and removed boards are never scanned.
- **Growth check:** `test/content/growth-sitemap.test.ts`, `Sitemap boards page, listed items`, and `Sitemap boards page, protected Realm content`, at 200, 1600 and 12800 listed boards or protected Realm boards behind a fixed page. Rows and statements stay constant; blocks stay logarithmic.

### Lift takedown

- Touches: the target row, its security revision and one outbox event, each constant. Projection re-admission uses
  the existing per-item takedown bound.

### Sitemap thread feed

- **Touches:** The board seek above, and for each disclosed board one keyset range of `board_thread_page_idx` rows by `(created_at, thread_id)` in pages of at most 200, with the shared thread disclosure per candidate. Candidates, board and thread, total at most 4L per page.
- **Bound:** L ≤ 1000, so O(L log N) rows and constant statements per page for a fixed L. Threads of protected Realms and removed boards are never scanned.
- **Growth check:** `test/content/growth-sitemap.test.ts`, `Sitemap threads page, listed items`, and `Sitemap threads page, protected Realm content`, at 200, 1600 and 12800 listed threads or protected Realm threads behind a fixed page. Rows and statements stay constant; blocks stay logarithmic.

### Author thread page

- **Touches:** One `readPublicViews` point read for the account in its partition, at most 4L index rows in the author's
  partition, and per candidate the subject thread read's disclosure probes in its thread's and board's partitions,
  each released before the next. For an authenticated viewer other than the account, the existing `account:update`
  Access check is prepared once and evaluated before scanning when the relevant view is private.
- **Bound:** The view check adds one bounded read per page. The existing Access check keeps its own bound; candidate
  rows and statements remain O(L) for L <= 20, independent of the account's item count.
- **Growth check:** `test/content/author-item-reads.test.ts`, `author thread page`, at 64, 512 and 4096 threads by
  the account. Rows and statements per page stay constant with the view check included.

### Author post page

- **Touches:** One `readPublicViews` point read for the account in its partition, at most 4L index rows, and per
  candidate the post and thread disclosure probes. For an authenticated viewer other than the account, the existing
  `account:update` Access check is prepared once and evaluated before scanning when the relevant view is private.
- **Bound:** The view check adds one bounded read per page. The existing Access check keeps its own bound; candidate
  rows and statements remain O(L) for L <= 20, independent of the account's item count.
- **Growth check:** `test/content/author-item-reads.test.ts`, `author post page`, at 64, 512 and 4096 replies by
  the account. Rows and statements per page stay constant with the view check included.

### Author erasure

Author erasure `steps` counts only logical page steps, including a denied page. `processedPosts` and `erasedRevisions` advance together at each page commit, when its post tombstones make the bodies unreadable. Exact counts visit only that page's revision identities (O(k) rows for k affected revisions); no unrelated history is traversed. Physical cleanup does not change progress counters.

- **Growth check:** `test/content/erasure-workflow.test.ts`, checkGrowth names `native content erasure pages`, `affected erasure revisions` and `native logical author page`.

Author erasure provenance stores `source_digest`, `original_minimum_authn_epoch`, `original_operator_account_id`, `original_delegation_transaction_id`, `original_delegation_issued_valid`, and `creation_command_kind`/`creation_idempotency_key`/`creation_request_digest`/`creation_target_route`/`creation_target_id` alongside the existing actor and transaction columns. The operation ID is its own immutable source; `native_workflow_id` remains the DBOS workflow ID. Accounts captures the original floor/operator from admission at the same attempt T and the original delegation through one point read when requested. The receipt alone includes `durableInitiator`, the SHA-256 commitment of the entire allowlisted record; public callers still receive `{ operationId }`. Historical NULL provenance cannot restore.

Authenticated paths and reserve's creator-grant insertion inherit the bounds derived in [Access Cost](../access/README.md#cost).
Media reserve's ancestor validation follows a possibly differently routed board on the same supplied connection without independently checking its partition, so that read shape assumes the pool can reach both homes on one machine.
Every C serializes on a partition-local position counter, not a global counter; board projection releases its source snapshot before opening the destination command, and imported image processing releases the source-fence read before media checkout.
R2 deletion validates only the selected object's prefix, with hard limits of 10000 listing pages and 100000 keys; normal publication writes at most thirteen keys, including deterministic retry leftovers.
Report storage/effects, standalone media erasure and download decisions remain unfinished, so their end-to-end costs cannot yet be derived from SQL helpers alone. Source-fence takedown and committed media purge are the other implemented governance/cleanup paths derived above; they do not implement those remaining decisions.

Content metadata is capped at write time and by database CHECK constraints: board and thread titles are 1–1024 characters; revision and imported licences are 1–128 characters; attribution, rights-holder, and via-name strings are 1–1024 characters; source URLs are at most 2048 characters and cover credit via URLs at most 1024; imported rights and cover-credit JSON documents are at most 8192 UTF-8 bytes; and imported-source and cover-provenance JSON documents are at most 65536 UTF-8 bytes (with at most 128 references). These caps make metadata bytes constant in content read and write Cost rows.
