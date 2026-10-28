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

### Realm sitemap feed

- Touches: At most `4 × limit` candidates ordered by `(route, realm_id)`. A public Realm adds its
  exact head revision read and one newest-board seek through `board_realm_page`.
- Bound: O(L log N) per page, with `L ≤ 1,000`; candidate and returned item counts are bounded by
  `4L` and `L` respectively. The shared list cursor keeps skipped Realm identities confidential.
- Growth check: `test/community/growth-sitemap.test.ts`, "Realm sitemap page stays within its bound as listed items grow" and "Realm sitemap page stays within its bound as protected Realms grow".

### Space sitemap feed

- Touches: At most `4 × limit` candidates ordered by `(route, space_id)`. Each candidate uses the
  anonymous `space:read` eligibility check. A listed Space adds its exact head revision read and
  `realm_route_space_id_key` slot probe; a filled slot adds one Realm primary-key read.
- Bound: O(L log N) per page, with `L ≤ 1,000`; candidate and returned item counts are bounded by
  `4L` and `L` respectively. The shared list cursor keeps skipped Space identities confidential.
- Growth check: `test/community/growth-sitemap.test.ts`, "Space sitemap page stays within its bound as listed items grow" and "Space sitemap page stays within its bound as protected Realms grow".

A is Access's bounded admission and permission evaluation; C is a partition-local `runCommand`
transaction. Access grant initialization uses fixed role templates and point inserts. R denotes
rows in the relevant partition. See [Access Cost](../access/README.md#cost) for its account and
grant lookup bounds.

| Operation                         | Touches                                                                                                                                                                                                             | Bound                                                      | Growth check                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create Space                      | One admission read and Global parent check (A); two inserts, a same-transaction creation proof and native grant initialization (C), in the Space partition; a fresh response carries null without another statement | O(1) rows and statements; O(log R) blocks                  | `test/community/growth-space.test.ts`, "Space create stays bounded at 256, 1024 and 4096 Spaces and their revisions", at 256, 1024 and 4096                               |
| Update Space                      | A on the Space with one point read joining its head; one revision insert and one head compare-and-set (C)                                                                                                           | O(1) rows and statements; O(log R) blocks                  | `test/community/growth-space.test.ts`, "Space update stays bounded at 256, 1024 and 4096 Spaces and their revisions", at 256, 1024 and 4096                               |
| Read Space with its carried Realm | Existing Space read and authorization; one exact `realm_route_space_id_key` lookup in that partition and, only when a Realm is found, one Realm head read with its ordinary `realm:read` evaluation (A)             | O(1) rows and statements; O(log R) blocks, plus A          | `test/community/growth-space.test.ts`, "Space read stays bounded at 256, 1024 and 4096 Spaces and their revisions", with the probe carrying a Realm at 256, 1024 and 4096 |
| Public eligibility                | One prepared point read and one current point verification through Access                                                                                                                                           | O(1) rows and statements; O(log R) blocks                  | `test/community/growth-space-address.test.ts`, "address claim, change and resolve stay bounded as addresses, Spaces and handles grow", at 256, 1024 and 4096              |
| Claim or change address           | One handle point read; one address-partition pending write; one Space head read, revision insert and head compare-and-set; one address activation and, for changes, one old-claim reservation                       | O(1) rows and statements; O(log A + S + H) blocks per step | `test/community/growth-space-address.test.ts`, "address claim, change and resolve stay bounded as addresses, Spaces and handles grow", at 256, 1024 and 4096              |
| Resolve address                   | One active address point read and the Space's normal read authorization and exact-head read                                                                                                                         | O(1) rows and statements; O(log A + S) blocks              | `test/community/growth-space-address.test.ts`, "address claim, change and resolve stay bounded as addresses, Spaces and handles grow", at 256, 1024 and 4096              |

The growth checks use `checkGrowth` with other identities and their revisions growing around a
fixed probe, and require zero sequential scans on community relations and the handle-claim table.
Metadata byte sizes are
bounded by the database character limits. Revision and predecessor lookups use exact routed keys;
no operation walks revision history or counts Spaces. Command serialization uses a partition-local
position counter.

| Operation    | Touches                                                                                                                                                                                                                                                                | Bound                                                                        | Growth check                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Create Realm | One admission observation shared by Global parent, Space and Context checks; one host point read and unique slot probe, prepared Context evidence and one Context verification at T; two inserts, a creation proof and grant initialization in the Space partition (C) | O(1) rows and statements; O(log R) blocks, plus A                            | `growth-realm.test.ts`: create as other Realms grow                          |
| Update Realm | A on the Realm and one exact head read; a supplied Context adds its prepared evidence and point verification at T; one revision insert and head compare-and-set (C)                                                                                                    | O(1) rows and statements; O(log R) blocks, plus A                            | `growth-realm.test.ts`: update a fixed probe at the same scales              |
| Read Realm   | One exact head read during public eligibility verification; protected reads require A's grant branch                                                                                                                                                                   | O(1) domain rows and statements; O(log R) blocks, plus A for protected reads | `growth-realm.test.ts`: public and protected fixed probes at the same scales |

A Realm publishes subjects into one slot per subject. The record history is append-only and the head
names the current record. `publish`, `withdraw` and `reject` require `realm:publish` on that Realm.
The owner and moderator role templates both include that action. Publishing confers no ownership
and writes no access grant, resource initialization or semantic row on the subject or the Global Context.

Each command attempt shares one admission observation between the Realm authorization and the
`subject:read` check. The anchor reads the active Realm at T and verifies the prepared subject check,
which uses `subjectReadEligibility`. Publishing into an empty slot needs no `If-Match`. An authorized
publisher can move an occupied slot by supplying its current head in the optional `If-Match` header;
without it, publish returns 409 and writes nothing, and a wrong head returns 412. Withdraw and reject
require `If-Match`, append a record and move the same head, so the slot leaves the adopted keyset in
the transaction that writes it.

`subject_revision_id` is null. The subject eligibility point read (`subject-public-evidence.sql`)
exposes visibility and a security revision, not a subject revision id. `readSubject` exposes an integer
`revision`, not a revision id.

`listPublications` fetches at most `L + 1` adopted heads for a limit of L, then prepares subject
checks for the first L candidates. In a repeatable-read snapshot it checks `realm:read`, rereads each
candidate's adopted head and checks `subject:read` with `subjectReadEligibility` before returning it.
Changed heads and subjects that fail disclosure are omitted without fetching replacements. The next
cursor follows the last candidate in that window when the initial seek found a lookahead row, so a
page can be short or empty and still have a continuation. `readPublication` checks `realm:read`, reads
one adopted head and checks `subject:read` in a repeatable-read snapshot. Both use the Realm's ordinary
read eligibility, including the public floor or the protected grant and current-ban checks.

### Publish, withdraw or reject

- Touches: One shared admission observation and prepared subject evidence per command attempt; one active Realm point read and subject authorization at T; one record insert and one head insert or compare-and-set, plus the command receipt and outbox event in the Realm partition.
- Bound: O(1) rows and statements; O(log R) blocks, plus A for Realm publication and subject read authorization.
- Growth check: `growth-publication.test.ts`, `checkGrowth` name `community publication write`, republishes a fixed subject as publications on other Realms and subjects grow. Withdraw and reject use the same write path but are not separately measured there.

### List publications

- Touches: One keyset seek of at most `L + 1` adopted heads, prepared subject checks for at most L candidates, one partition epoch read and Realm read authorization, then at most L head point rereads and subject read checks in the final snapshot. Skipped candidates count toward L; there is no count, offset or refill.
- Bound: O(L) domain rows and statements and O(L log R) blocks, plus A for the Realm and each candidate, with `L ≤ 100`.
- Growth check: `growth-publication.test.ts`, `checkGrowth` name `community publication page`, keeps the probe Realm and page fixed as publications on other Realms and subjects grow.

### Read a publication

- Touches: Prepared Realm and subject checks, one Realm read authorization, one adopted-head point read and, when the head exists, one subject read check in the final snapshot.
- Bound: O(1) domain rows and statements; O(log R) blocks, plus A for the Realm and subject.
- Growth check: No separate single-publication growth measurement; `community publication page` in `growth-publication.test.ts` measures the same head reread and disclosure path within a fixed page.

A Realm's `boardSchemeId` is initially null. `setBoardScheme` requires `realm:manage`,
reads the proposed subject through Semantic's own subject/statement reader and
`subjectReadEligibility` at the command's T, and accepts only `skos:ConceptScheme`.
It appends a revision and compares the expected head before updating the identity.
Metadata-only revisions inherit the scheme from their predecessor. The Realm reader
in `board-scheme.ts` includes the scheme in its exact head read, including HTTP reads.
`PUT /v1/realms/{realmId}/boardScheme` requires `If-Match`, `Idempotency-Key`, and
`{ schemeId }`. Board concepts remain ordinary `skos:Concept` subjects linked by
`skos:inScheme`; Semantic has no per-Context scheme table.

| Operation             | Touches                                                                                                                                                                                                                                                                | Bound                                             | Growth check                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Set/read board scheme | One admission observation shared by Realm management and subject eligibility; one Realm head point read and Semantic's subject/type read at T; one revision insert and head compare-and-set in the Realm partition. Reading includes the scheme in the Realm head seek | O(1) rows and statements; O(log R) blocks, plus A | `board-scheme.test.ts`: fixed Realm and scheme as other Realms and subjects grow; constant rows/statements and zero sequential scans on Realm and subject identities/revisions |

The board scheme and publication HTTP tests use genuine Auth-issued tokens and
production Access. They cover a suspended-account persona through the native
`account:suspend` route, called by platform governance. The persona's existing
bearer receives 401 when setting a board scheme, publishing, withdrawing or
rejecting, with the Realm head and publication rows unchanged.

Accounts owns the durable membership workflow and the actor-side inverse.
`createRealmMembership` is the Realm partition adapter that workflow calls.
`publish` runs in the Realm partition under the workflow step key. Role `member`
opens `[T, infinity)` when no interval covers T. Role null closes the interval
that covers T for that reservation and writes the terminal slot. The Realm must
be active at T. Role `owner` is rejected: Realm owners are identity grants, not
membership rows. The actor needs `realm:join` when joining themselves and
`realm:manage` otherwise. `terminalize` writes the terminal slot only when that
reservation has no member row, so an unpublished reservation can be closed and a
published one cannot. Terminal rows are immutable. `readTerminal` and `readChange`
are exact point reads of committed evidence. The role reader returns the owner
and member proofs, using the current temporal key and the next lower-bound seek.

`GET /v1/me/realms?cursor=` lists only the authenticated active account's current
Realm memberships at its current authentication floor. It keyset-pages the
account's `access.membership_inverse` rows, 20 items per page. The inverse is a
candidate index: each Realm is confirmed against that account's current
`community.realm_member` row at the request's T, and the name and role come from
the confirmed membership and current Realm head. A cursor is signed, bound to
the viewer and the account partition epoch. Each page scans no more than 80
inverse candidates and performs at most 80 current-membership point reads;
stale inverse rows are skipped and cannot make a page unbounded.

### Durable initiators

Accepting a join, leave, add-member or ban removal runs one native command on the Realm's
partition with the authenticated actor. It authorizes the action, captures the actor, original
floor, operator and delegation through `captureDurableInitiator`, and commits one immutable
`realm_membership_operation` row with its creation receipt. The receipt's `durableInitiator`
commits the whole record, so a copied row or receipt never restores. Only then does it enqueue.
The sealed workflow reference names that operation and repeats the request's facts; it carries no
actor and no scopes.

Every workflow step calls `restoreInitiator` inside the command's `prepare`, at the attempt's T,
over that committed operation and Auth's current consent, and authorizes with the actor it returns.
A revoked grant, withdrawn or reduced consent, suspended or fenced account, or a changed floor
denies the step with no effect. The initiator is the person who asked: the member for a join or
leave, the manager for add-member, the moderator for a ban removal. `createRealmMembership`
takes the restorer; without one, a sealed step fails closed. A reference that is not sealed
authenticates through Access, and `publish` authorizes with that authenticated actor object itself,
never a copy: production admission knows no other object. The kernel's worker composes both from
the one Auth consent configuration (`KERNEL_AUTH_CONSENT_URL`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`); with the group absent, restoration is unavailable.
A missing Realm, or one that is not yet active at T, has no proof.

| Operation               | Touches                                                                                                               | Bound                                                                                                         | Growth check                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish membership      | One Realm point read at T, one interval open or close, and at most one terminal insert in the Realm partition, plus A | O(1) rows, O(log R) blocks, plus A                                                                            | `growth-membership.test.ts`: a fixed probe as members of other Realms and accounts grow; constant rows and statements, zero sequential scans |
| Read current membership | One `realm_member_open` unique index point read, filtered at T; closed history does not widen the lookup              | O(1) row and statement; O(log N) blocks, where N is the Realm's membership history including closed intervals | `growth-membership-history.test.ts`: one row and statement, zero sequential scans as closed intervals of the same account and Realm grow     |
| List own Realms         | At most 80 caller-route inverse rows by keyset, then one current `realm_member` primary-key read per candidate        | At most 80 + 80 rows and constant statements; O(log R) blocks                                                 | `own-realms.test.ts`: one caller and other accounts' memberships grow at three scales; constant rows/statements and logarithmic blocks       |
| Read terminal or change | One point read, on the terminal primary key or `realm_member_change`                                                  | O(1) rows, O(log R) blocks                                                                                    | test/community/growth-membership.test.ts, "publish, terminal reads and role proofs stay within their bound as Realms and members grow"       |
| Role proof              | Two membership index seeks (the temporal primary key and `realm_member_next`) plus the Realm existence point          | O(1) rows, O(log R) blocks                                                                                    | test/community/growth-membership.test.ts, "publish, terminal reads and role proofs stay within their bound as Realms and members grow"       |

### Check Realm participation

- Touches: One Access evaluation for `realm:participate`, one `realm:read` eligibility check, and one exact Realm head read at their shared T.
- Bound: O(1) rows and statements plus Access's bounded membership proof; O(log R) blocks.
- Growth check: `participation.test.ts` keeps the protected Realm probe fixed as Realms, members and grants grow; constant rows/statements and zero sequential scans.

### Ensure protected Realm member grant

- Touches: One exact Realm head read and one idempotent `resource_role_grant` insert in the Realm command transaction.
- Bound: O(1) rows and statements; O(log R) blocks.
- Growth check: `participation.test.ts` asserts one group grant after protection and uses the same bounded checks as Realms, members and grants grow.

### Join a Realm

- Touches: One acceptance command (admission, one Realm point read, one current-ban point read, one operation insert, the creation receipt), then the membership workflow's own bounded reserve and publish steps, each adding one initiator restoration, then one follow point upsert on the member's account partition. Member publication rechecks the current-ban key before writing.
- Bound: O(1) rows and statements per step, plus Access and one restoration; O(log R) blocks. No scan of members.
- Growth check: `test/community/growth-join.test.ts`, "Join a Realm has constant rows and statements as Realms and its members grow", at scales 1, 4 and 16 (500, 2000 and 8000 seeded neighbours); zero sequential scans.

### Leave a Realm

- Touches: One acceptance command as for join, then the membership workflow's own bounded reserve, publish and release steps. Leave writes no follow and never unfollows.
- Bound: O(1) rows and statements per step, plus Access and one restoration; O(log R) blocks. No scan of members.
- Growth check: `test/community/growth-join.test.ts`, "Leave a Realm has constant rows and statements as Realms and its members grow", at scales 1, 4 and 16 (500, 2000 and 8000 seeded neighbours); zero sequential scans.

### Add a Realm member

- Touches: The same acceptance command and membership workflow as join, one idempotent member-group grant when the Realm is protected, and one follow point upsert.
- Bound: O(1) rows and statements per step, plus Access and one restoration; O(log R) blocks. No scan of members.
- Growth check: `test/community/growth-join.test.ts`, "Add a Realm member has constant rows and statements as Realms and its members grow", at scales 1, 4 and 16 (500, 2000 and 8000 seeded neighbours); zero sequential scans.

### Read own Realm membership

- Touches: One `realm_member_open` unique index point read of the member's open interval, filtered at T, after the Realm read check. Closed intervals do not widen the lookup.
- Bound: O(log N) blocks, one row and one statement. N is the Realm's membership history, including closed intervals.
- Growth check: `growth-membership-history.test.ts` fixes one account and Realm as closed intervals of that same membership and unrelated memberships spread across routes grow; one index point read, one row and one statement at every scale, zero sequential scans.

### Read Realm votes

- Touches: one primary-key read of community.realm per given Realm, one statement per partition.
- Bound: O(n log R) for n Realms.
- Growth check: `test/community/realm-votes.test.ts`, `checkGrowth` name `Read Realm votes`: a fixed set of Realms read with constant rows and statements as Realms grow.

### Ban an account

- Touches: One admission and Realm authorization; one Realm record write and two identity denial writes in the Realm partition, one bounded owner/moderator probe through Access's grant keys, plus a member interval point read and, when present, one removal acceptance command (one operation insert) and one native leave workflow keyed by the ban.
- Bound: O(1) rows and statements in the ban command, plus Access and one leave workflow; O(log R) blocks. No scan of members, bans or content.
- Growth check: `test/community/growth-ban.test.ts`, "ban, unban and the ban list stay within their bound as Realms, bans and members grow", at 256, 1024 and 4096 neighbouring Realms, each with one ban and one member, around a fixed probe; zero sequential scans.

### Unban an account

- Touches: One admission and Realm authorization; one Realm record close and two identity denial closes in the Realm partition.
- Bound: O(1) rows and statements, plus Access; O(log R) blocks. Membership is not restored.
- Growth check: `test/community/growth-ban.test.ts`, "ban, unban and the ban list stay within their bound as Realms, bans and members grow", at 256, 1024 and 4096 neighbouring Realms, each with one ban and one member, around a fixed probe; zero sequential scans.

### List current bans

- Touches: One admission and Realm authorization; one current-ban keyset seek of L rows, with one lookahead row for the next cursor.
- Bound: O(L) rows and O(1) statements, plus Access; O(log R + L) blocks. Historical intervals and other Realms do not widen the window.
- Growth check: `test/community/growth-ban.test.ts`, "ban, unban and the ban list stay within their bound as Realms, bans and members grow", at 256, 1024 and 4096 neighbouring Realms, each with one ban and one member, around a fixed probe; zero sequential scans.

### Protected Realm read and admission ban check

- Touches: One current-ban point read by route, Realm and account in the Realm partition, at the read or command's T. Protected read eligibility applies it before the independent grant branch; public reads skip it. Join and add-member check before accepting an operation, and membership publication rechecks before writing.
- Bound: O(1) rows and statements; O(log B) blocks for B bans. Closed history does not widen the current key.
- Growth check: `test/community/growth-ban.test.ts`, "protected read and admission ban probes stay bounded as bans in one Realm grow", at 256, 1024 and 4096 bans around fixed present and absent probes; zero sequential scans.
