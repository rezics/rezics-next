# Subject Collection journey

A Subject reader inspects the public Collections that contain this Subject, continues through later public pages,
opens one disclosed Collection, returns to the same reader, and adds the exact Subject to a later owned curated
Collection. The existing Library slot is the only owner of this list and chooser. Collection editors, saved-query
managers, discovery feeds and publication remain their own journeys.

## Public list

`GET /v1/subjects/{id}/collections` remains the native authority. Each explicit page requests **L=20** rows
(`pageQuery` default 20, cap 100) and an opaque cursor of at most **C=4,096** characters. The FULL page supplies
`collections`, `next` and `count:{value,exact:true}`. Web copies that exact count when `exact` is true and `value` is
a safe integer ≥ 0; missing or invalid count stays unknown. Unknown is never shown as zero or as this page's row
count. Public, unlisted and private meaning, curator projection and multiplicity come from that endpoint. Web does
not look up a private Collection to enrich a concealed public row, and it does not scan members or follows.

A valid `next` permits an explicit next request, including on an empty or sparse page. Exhaustion is `next=null`, not
`rows.length < 20`. A stale or invalid cursor retires the displayed rows and offers an explicit first-page restart.
A failed source read is not a successful empty list. Continuation is component-local; it is not stored in the Subject
URL, history state, metadata or share output. Public Collection return uses canonical Collection and Subject links
with the existing `subjectSlotReturnTo` selectors (locale, Realm, node, view, cursor, useful `slot=collections`).

## Private chooser

The Add to Collection chooser loads only when a signed-in reader opens it. It keeps the current viewer, exact
Subject, selected page and native `next`. One owner list request (`GET /v1/collections?curatorAccountId=…`) returns
the current page. Dynamic and built-in identities are not curated write destinations: `membershipKind === 'dynamic'`
or a present `builtinKind` is refused; `membershipKind === 'curated'` is selectable. A missing `membershipKind` with a
numeric `memberCount` is treated as curated because dynamic DTOs omit that field. Titles are never used as
discriminants, and occurrence IDs are never synthesized.

Selecting a row captures its id, title and permitted identity for review. Paging, refresh or a later page response
cannot change that captured target or mint a replacement command key. Previous steps back once; Restart rereads page
one; Next consumes the opaque frontier. Closing the chooser returns focus to its trigger. Next and Restart expose the
list heading and do not move focus into an add action.

## Member command

`POST /v1/collections/{collectionId}/members` with `{subjectId}` is the only writer. Duplicate Subject occurrences
remain allowed. Native admission, `collection_full` and `dynamic_membership_immutable` stay authoritative. An
uncertain command keeps its original viewer, credential, idempotency key and body. Explicit retry uses that sealed
intent only. Paging, refresh or choosing another Collection does not retarget it. A confirmed receipt updates only
the matching current slot and offers the exact Collection link plus return to the current Subject. A definitive
refusal leaves rich-entry, note, priority, privacy, diary and occurrence controls unchanged so the person can correct
the Collection choice. Selection and recovery never retry automatically.

Account replacement, sign-out, gate or access loss, and Subject or route replacement retire chooser rows, pending
public and private reads and local callbacks before any destination work. A public list may remain visible while
private state is withheld. Private chooser state stays in the active browser and is never embedded in public SSR,
metadata, history state or share output. Back and Forward restore only validated navigation selectors; an old
frontier that is no longer accepted offers explicit restart.

## Cost

Each public or chooser page uses one native list request. A confirmed add uses the existing one member command plus
at most one explicit bounded current-page refresh. There is no per-row hydration, total scan, automatic refill,
prefetch of all pages or accumulation of the account catalogue. Retention is the current public page, the current
private page and a bounded navigation descriptor: **O(L+T+C)** projected data, independent of total public or owned
Collections N. A true native total is supplied by its producer. Indexed producer work stays Commerce-owned.

Decision: browse visits retain the current page plus one previous cursor; Previous steps back once; Restart rereads
page one. Native page size is 20.
