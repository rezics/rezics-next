# Community

A Space is the stable, routed identity for a future Realm (community) or Zone (site).
Its metadata is an append-only revision chain; the Space points to its current head.
This module provides commands, point reads and HTTP routes.

`createSpace` derives its route from the authenticated account and idempotency key.
It requires `space:create` on the Global Context through `parentCreationAuthorization`.
One `runCommand` transaction inserts the Space, its first revision and native Access initialization:
`community.space.owner` grants the creator `space:read` and `space:manage`, and
`community.space.standing` grants active accounts `space:read`. Initialization never grants on the parent.
The installed action catalogue must contain these actions for the template to resolve.

`updateSpace` requires `space:manage` on the Space. It preserves omitted fields, appends a revision
and moves the head with a compare-and-set against `expectedHead`. `SpaceConflictError` means that
head has changed; the transaction rolls back without a revision, receipt or grant write.
Authorized same-key replays return the stored outcome before checking the old expected head.
`SpaceInputError` identifies invalid metadata. Titles contain 1–1024 Unicode characters and
summaries at most 4096; PostgreSQL independently enforces these limits and revision immutability.
The initial state is `active`; lifecycle transitions are outside this module's current commands.
Creator and author accounts are external identities and can have different routes from the Space.

`readSpace(client, spaceId, time)` joins the identity to its exact head on the supplied connection.
It returns metadata and the head's active address without implying permission. Callers compose Access `space:read` with
`spaceReadEligibility`, which prepares non-null domain evidence and verifies the current active
Space and head at Access's authoritative time. Missing domain evidence denies public reading.

Every HTTP Space representation includes the output-only `realmId`. `readSpaceForViewer` reads
its exact `realm_route_space_id_key` slot in the Space's partition, then calls `readRealm` once
only when that slot carries a Realm. The id is exposed only when the Realm is active and the
viewer passes its ordinary `realm:read` check, including its read eligibility. Otherwise it is
null, with the same body, status and headers as before the Space carried a Realm. Space
creation returns null without a slot lookup; a replay derives the field from current visibility.
This field is derived per viewer, outside the Space's revision chain. The Space ETag remains
its head revision id and the `If-Match` token for Space writes; a Realm or membership change
can change `realmId` without changing that ETag. Space authorization is unchanged.

`PUT /v1/spaces/{spaceId}/address` requires `space:manage`, `If-Match`, and `Idempotency-Key`.
Addresses use Access's ASCII handle normalization but live in `community.space_address_claim`,
their own namespace. A handle claim is checked by one routed point read: an active or unexpired
reserved handle blocks the same address unless the claimant is that account or an owner of its
organization. A free address is receipted as pending in its address partition, added to a new Space
revision with a head compare-and-set, then activated in the address partition. A changed address's
previous claim is reserved for 30 days. Pending claims expire after 30 minutes and can then be
reclaimed. Every step is a separate single-partition command with the request's idempotency key;
retries resume from the saved receipts. `GET /v1/spaceAddresses/{address}` point-reads an active
claim and returns `{ spaceId }` only when the Space passes its ordinary `space:read` check.

A Realm is the community carried by a Space. `createRealm` mints its distinct identity
and initial revision on the Space's route, with `realm:create` on the Global Context
and `space:manage` on the host. Both checks use the same trusted command context and
share one admission observation. The host must exist and be active at T. Its single
Realm slot is observed at T and enforced before new writes and by a unique database
key, so concurrent creations cannot both commit. Authorized receipt replays can return
their original result without attempting to claim the slot again.

The classification `contextId` must name an existing Context readable through
`publicContextEligibility`. Context authorization is prepared before target checkout
and verified at the command's T. `updateRealm` requires `realm:manage`, appends a
revision and compares `expectedHead` before moving the head. It preserves omitted
metadata and rechecks any supplied Context. Visibility and classification on the
identity must agree with its head; a deferred foreign key enforces this in PostgreSQL.
Realm identity, host and creation provenance are immutable, and revisions are append-only.

`community.realm.owner` grants `realm:read`, `realm:manage`, `realm:ban`, `realm:publish`,
`board:create`, `access:grant` and `moderation:takedown`. `community.realm.moderator` grants
`realm:read`, `realm:ban`, `realm:publish`, `board:create` and `moderation:takedown`.
The takedown action applies to threads and posts in that Realm. The standing role grants
active accounts `realm:participate`; `community.realm.member` grants both `realm:read`
and `realm:participate` through the Realm's `member` group. `realmReadEligibility`
supplies public read eligibility only while the current Realm is public.
`readRealm(deps, actor, realmId, { deadline })` performs the head read inside that
eligibility verification at Access's authoritative T. A protected Realm requires a
native `realm:read` grant; denied and missing reads both return null.

`createRealmParticipationCheck({ pool, access })` checks `realm:participate` and the
independent `realm:read` anchor at one T. The read anchor ensures that the standing
participation grant cannot expose a protected Realm to a non-member. The
`GET /v1/realms/{realmId}/participation` route returns 204 when both checks pass, 403
when a readable Realm denies participation and the ordinary 404 when the Realm cannot
be read. A `realm_ban` denial applies to `realm:participate` even when the Realm is public.

`ensureRealmMemberGrant(tx, { realmId })` installs the identity role grant for the Realm's
`member` group only while that Realm is protected. It is idempotent and requires the
current command to target that exact Realm. `updateRealm` calls it after moving the head
when the new visibility is protected, in the same transaction as `realm.updated`.

`PUT /v1/realms/{realmId}/bans/{accountId}` opens a Realm-owned ban record and
`realm_ban` identity denials for `realm:join` and `realm:participate` at the command's T.
`banAccount` requires `realm:ban` on that Realm. Owners and moderators carry that action.
A target holding the Realm's owner or moderator resource role is refused with 409 and
must have the role removed first. From T, a protected Realm's read eligibility checks
one indexed current-ban key in its own partition and refuses every grant for a banned
account. The Realm, carried Realm ID, boards, threads, posts and publications are hidden
even while removal is pending or an independent read grant remains. Public reads still
answer exactly as for an anonymous reader. A read identity denial would also veto public
eligibility, so protected reads consult the ban record instead. Join and add-member acceptance and membership
publication refuse a currently banned target without writing an operation, membership,
grant or follow. After unban, join and add-member work again.
An existing member is removed by Accounts' native leave workflow: publish closes the
Realm interval before release clears the account's inverse slot. The workflow is keyed
by the ban. Its operation commits the moderator as initiator (see Durable initiators
below), and each step needs that moderator's own `realm:ban` on the Realm; the member's
permission is irrelevant. A non-member starts no workflow. Retrying a receipted
ban resumes enqueueing with the same durable key.

`DELETE /v1/realms/{realmId}/bans/{accountId}` requires the same action and ends both
denials in the record's transaction. Both mutations use `Idempotency-Key`. Unban never
restores membership. `GET /v1/realms/{realmId}/bans` requires `realm:ban` and returns
current records ordered by account ID, with an opaque cursor bound to the Realm,
viewer, limit and partition epoch. Denials stay on the Realm; content writes must check
Realm participation directly, and public reads remain open.

## Sitemap feeds

`GET /v1/sitemap/realms` returns public Realms as `{ id, lastModified }`. `GET /v1/sitemap/spaces`
returns anonymously readable Spaces with an address as `{ id, address, lastModified }`; it omits a
Space whose Realm slot is occupied by a protected or inactive Realm. Both are public server-to-server
feeds evaluated as an anonymous reader, even when a bearer is present. They use keyset cursors and
may return fewer items than requested when candidates are skipped. Pages may contain up to 1,000
items, an exception to the shared list maximum of 100. Their positions use the shared opaque list cursor contract in
[`../tokens/list-cursor.ts`](../tokens/list-cursor.ts), bound to the feed route, anonymous viewer and empty query.
`lastModified` is the current head revision time; a Realm also uses the time of its newest board when that is later.
Realm and Space items come in strictly increasing `(route, id)` order.

## Cost

| Operation | Touches | Bound | Growth check |
| --- | --- | --- | --- |
| Create Space | Global admission and authorization; one Space insert, first revision insert, creation receipt and fixed native grant initialization in the Space partition. | Constant rows and statements; logarithmic blocks in partition and Space population. | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”. |
| Update Space | Space authorization and exact head read; one revision insert and head compare-and-set, with receipt in the Space partition. | Constant rows and statements; logarithmic blocks in partition and revision population. | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”. |
| Read Space with its carried Realm | Space read and authorization; exact head read, one carried-Realm slot lookup, and at most one Realm head read with its ordinary read authorization. | Constant rows and statements; logarithmic blocks in the Space and Realm indexes. | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”. |
| Public Space eligibility | One prepared Space point read and one current Space/head verification at Access's authoritative time. | Constant rows and statements; logarithmic blocks in the Space indexes. | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”. |
| Claim or change Space address | Routed handle point read; pending claim write; Space head read, revision insert and compare-and-set; address activation and, on change, reservation of the old claim. Each phase is a single-partition command. | Constant rows and statements per step; logarithmic blocks in address, Space and handle indexes. | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”. |
| Resolve Space address | Active address point read followed by the Space's normal read authorization and exact head read. | Constant rows and statements; logarithmic blocks in address and Space indexes. | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”. |
| Create Realm | Shared admission for Global, host Space and Context checks; exact host and slot reads; prepared Context evidence and verification; Realm identity, first revision, receipt and fixed grant initialization in the host partition. | Constant rows and statements; logarithmic blocks in the host partition, plus bounded Access checks. | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”. |
| Update Realm | Realm authorization and exact head read; supplied Context adds one prepared evidence read and point verification; one revision insert and head compare-and-set. | Constant rows and statements; logarithmic blocks in the Realm partition, plus bounded Access checks. | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”. |
| Read Realm | Exact Realm head read during public eligibility; protected reads also evaluate the native `realm:read` grant. | Constant domain rows and statements; logarithmic blocks, plus bounded Access checks for protected reads. | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”. |
| Publish, withdraw or reject a publication | Admission and Realm authorization; exact subject-slot and current-head reads; one append-only publication record and slot/head change in the Realm partition, with receipt. | Constant rows and statements per command; logarithmic blocks in Realm and subject indexes. | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”. |
| Read or list publications | Read one subject's current publication slot/history or keyset-page a fixed limit of Realm publications, with the corresponding exact Realm and subject reads. | Constant rows for a point read; linear rows in page limit for a list; logarithmic blocks in the relevant indexes. | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”. |
| Set or read board scheme | Admission for Realm management and subject eligibility; Realm head and Semantic subject/type point reads; setting appends one revision and compare-and-sets the head, while reading uses the head seek. | Constant rows and statements; logarithmic blocks in Realm and subject indexes, plus bounded Access checks. | `test/community/board-scheme.test.ts`: `Realm board scheme set and read`. |
| Publish membership, read terminal or change, or prove a role | Publish reads the Realm and opens or closes one membership interval, with at most one terminal insert. Terminal/change reads use one primary-key point read; role proof uses two membership index seeks and the Realm existence point. | Constant rows and statements per operation; logarithmic blocks in Realm membership indexes, plus bounded Access. | `test/community/growth-membership.test.ts`: “publish, terminal reads and role proofs stay within their bound as Realms and members grow”. |
| Read current Realm membership | One unique `realm_member_open` index point read filtered at T; closed history does not widen the lookup. | One row and statement; logarithmic blocks in the Realm's membership history, including closed intervals. | `test/community/growth-membership-history.test.ts`: “current membership is one index point read as the same account and Realm accumulate closed intervals”. |
| List own Realms | Keyset-read at most 80 caller-route inverse rows, then confirm each candidate with one current `realm_member` primary-key read. | At most 160 rows and a constant number of statements; logarithmic blocks in the inverse and membership indexes. | `test/community/own-realms.test.ts`: “own Realm pages use confirmed memberships, signed cursors and bounded inverse scans”. |
| List Realm and Space sitemap pages | Keyset-read at most four candidates per requested item (limit at most 1,000); each eligible item reads its exact head and related Realm/board slot as applicable. Skipped protected or inactive candidates remain bounded. | Linear rows in page limit with at most four times the limit candidates; logarithmic blocks in feed indexes. | `test/community/growth-sitemap.test.ts`: “Realm sitemap page stays within its bound as listed items grow”; “Space sitemap page stays within its bound as listed items grow”; “Realm sitemap page stays within its bound as protected Realms grow”; “Space sitemap page stays within its bound as protected Realms grow”. |
| Check Realm participation or ensure its member grant | Participation checks `realm:participate`, the independent `realm:read` eligibility and one exact Realm head at shared T. Grant ensure reads the exact Realm head and idempotently inserts the member-group grant in the command. | Constant rows and statements; logarithmic blocks, plus bounded Access membership proof. | `test/community/participation.test.ts`: “Realm participation stays bounded as Realms, members and grants grow”. |
| Join a Realm | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; reserve and publish workflow steps restore the initiator; follow is one point upsert on the member account partition. Publication rechecks the ban. | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history. | `test/community/growth-join.test.ts`: “Join a Realm has constant rows and statements as Realms and its members grow”. |
| Leave a Realm | Acceptance command reads the Realm and current-ban key and inserts one operation and receipt; reserve, publish and release steps restore the initiator. No follow is written or removed. | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history. | `test/community/growth-join.test.ts`: “Leave a Realm has constant rows and statements as Realms and its members grow”. |
| Add a Realm member | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; workflow reserves and publishes with initiator restoration, ensures the protected member grant, and upserts the member's follow point. | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history. | `test/community/growth-join.test.ts`: “Add a Realm member has constant rows and statements as Realms and its members grow”. |
| Read Realm votes | One primary-key read of `community.realm` per requested Realm, with one statement per partition. | Linear rows and statements in the number of requested Realms; logarithmic blocks per Realm. | `test/community/realm-votes.test.ts`: `Read Realm votes`. |
| Ban, unban or list current bans | Ban opens the Realm ban record and two identity denials, checks the owner/moderator grant keys and probes current membership; an existing member also gets a removal operation/workflow. Unban closes the record and denials. Listing keyset-reads at most L current bans plus one lookahead row. | Ban and unban have constant rows and statements; listing has linear rows in L and constant statements. Logarithmic blocks in Realm and ban indexes, plus bounded Access and removal workflow where applicable. | `test/community/growth-ban.test.ts`: `Realm ban, unban and list`. |

A is bounded Access admission and permission evaluation. Each `runCommand` phase is a single-partition transaction. Fixed request, page and change limits are inputs; no operation above depends on scanning unrelated history. Bounds describe database rows, statements and indexed blocks, not wall-clock latency or engine posting-list work.
