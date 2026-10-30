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

When Accounts reuses the current live membership reservation for another join or
owner add, publication confirms the exact current membership by its open-key index
and records the fresh transition proof without changing the interval or emitting
another membership event. A different reservation does not satisfy the operation.
Authorization and the current-ban check still apply.

`PUT /v1/realms/{realmId}/bans/{accountId}` opens a Realm-owned ban record and
`realm_ban` identity denials for `realm:join` and `realm:participate` at the command's T.
`banAccount` requires `realm:ban` on that Realm. Owners and moderators carry that action.
A target holding the Realm's owner or moderator resource role is refused with 409 and
must have the role removed first. From T, a protected Realm's read eligibility checks
one indexed current-ban key for the actor and, when delegated, the principal, in one
statement in its own partition, and refuses every grant if either account is banned.
The Realm, carried Realm ID, boards, threads, posts and publications are hidden
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
restores membership. Independent grants remain intact and become readable on the next
request with the original bearer, without rejoining or regranting.
`GET /v1/realms/{realmId}/bans` requires `realm:ban` and returns
current records ordered by account ID, with an opaque cursor bound to the Realm,
viewer, limit and partition epoch. A record's `actor` is null once the moderator's account is erased. Denials stay on the Realm; content writes must check
Realm participation directly, and public reads remain open.

The Space home exposes Realm ban management through these native endpoints. Its personal current-ban list
is also the current `realm:ban` authority check, independent of membership or cached role labels. Each page
requests 20 records and keeps the native continuation; unavailable or denied reads never become empty lists.
The ban response's non-null `workflowId` means removal was queued, not completed. The list supplies no removal
completion status, so refreshing it cannot prove settlement. Unban permits later admission under the Realm's
ordinary rules without restoring membership or changing follows; existing removal work may still be pending.
A role-conflict response asks for genuine owner/moderator role removal before another ban attempt.

The same ban precedence applies to non-public boards and their descendants in a public
Realm, whether the independent grant names an account, an organization role or a
delegated actor. Content owns those board checks. Protected Realm eligibility uses
`read-ban-current.sql`: one statement probes at most the actor and principal's indexed
current keys in the Realm partition, with O(log B) work per key for B ban records.
It does not enumerate grants, boards or members. `test/community/growth-ban.test.ts`
covers both identities as B grows through 256, 1024 and 4096 records, holding statements
and returned rows constant.

## Realm ownership continuity

Access owns explicit owner roles, the last-holder leave guard, candidate ordering and erasure succession.
Content does not infer ownership from membership, Global grants or unavailable candidate evidence. Succession is
Realm-only. A successor's native grant and the Realm resource's returned owned-or-orphaned decision must commit
in the same Realm-home transaction. The account-erasure participant remains the sole orchestrator and ACK writer;
a Content transaction result alone never acknowledges account erasure.

The existing Realm identity stores `ownership_state`, `orphaned_at` and `claim_eligible_at`, independently of its
classification Context and Global subject identity. Orphaning keeps ordinary public/authorized reads and discussion
participation. `RealmView` exposes `ownershipState`, `orphanedAt`, `claimEligibleAt` and `governanceReadOnly`.
`realmGovernanceAuthorization` consumes existing Access admission and locks the current native Realm/head before
receipt replay or mutation. Orphaned metadata, board scheme, vote configuration, publication and board creation
are read-only even for an independently granted or Global actor. It never grants an action or changes a role.
The locked identity serializes governance against the actual succession transaction and preserves removal's
separate lifecycle check.

`requestRealmClaim(deps, actor, realmId, { idempotencyKey, deadline })` uses ordinary `realm:participate` admission and an
independent current `realm:read` check. It accepts only an orphan whose original `orphaned_at + 720 hours` has
elapsed at authoritative command time. The database preserves that deadline during orphan retries. A native
pending request is unique per Realm, original orphan instant and requester; a fresh idempotency key returns the
same pending request without another event. The result is always `pending`; neither expiry nor requesting grants
ownership. Approval requires a genuine platform decision establishing a native Access owner. The native command exposes no
approval operation without that authority.

Claim requests are held in the Realm home. A request point touches one native identity/head, one full requester
key and a bounded receipt/event bundle, without enumerating members, requests or grants. The claim-requested
event extends the existing party locator: it point-reads the full Realm/request key, releases that connection,
then registers requester custody in the account home under the existing erasure fence. The existing Community
records eraser deletes the exact request under the committed account-erasure obligation. A late event uses the
same eraser and resolves its existing late-item obligation; replay reads current attribution and cannot recreate
a deleted request or locator. The account-erasure participant remains the sole ACK writer.

## Realm transition publication proof

Every positive native membership publication requires the fresh Access transition returned by inverse reservation.
Stable reservation and transition generation are separate. Under the Realm row lock the transaction writes
membership (or confirms the same live reservation), its native receipt response and an immutable
`realm_membership_proof` keyed by Realm, member and generation. The receipt binds the original operation, generation,
stable reservation, outcome and publication transaction. `authority.readTransition(client, transition)` returns
`RealmMembershipProof | null` only for this exact committed source. A closed or unrelated generation cannot publish;
a queued old writer encounters the already committed proof slot and refuses. Raw native receipt replay retains its
original digest and result.

`cancel(transition, key)` is an exact mechanical compensation command. It serializes against publication and returns
its committed publication if publication won; otherwise it commits immutable cancellation. An existing live member
is never erased to manufacture terminal absence. Ordinary `terminalize` and terminal inverse release keep their
existing authoritative rules. Cancellation consumption retains the inverse; compensation must separately commit
ordinary absence-only terminalization before terminal release. When supplied its exact generation, ordinary
terminalization also records its cancellation proof in that same transaction. The shared Accounts workflow releases
the source checkout before consuming proof on the account anchor. Publication retains the membership and inverse.

The deployment-only `certifyLegacy(transition, key)` requires adopted stable provenance under the stopped-old-writer
barrier. It certifies an exact native live or terminal source receipt, not a missing source. The normal Accounts host
registers its bounded, persisted coordinator; see [Access's transition protocol](../access/README.md#realm-transition-coordination-and-deletion-entry).
Both migrations are required before new writers start. New-generation source proofs name the full native receipt
primary key. Legacy certification instead has only its old source transaction identity; Core currently lacks a
bounded lookup for that identity. Legacy reconciliation must not be deployed until the Core owner supplies that
lookup. Transition migrations do not alter Core receipt machinery. Source proofs remain physical-custody obligations
pending real erasure producers; this protocol supplies deletion entry, not participant completion.

Cost: one active Realm lock, current membership/ban/authorization probes, one generation proof and exact receipt
binding per publication/cancellation; constant rows/statements/output with logarithmic index blocks. The native
64/512/4096 growth series in `test/access/growth-realm-membership-transition.test.ts` includes the shared workflow,
Access consumers, source proofs, transaction controls and DBOS work.

## Participation on the Space home

The Space home keeps Realm membership separate from following the Space. Public self-join and direct,
owner-selected add-member use the existing membership commands and their `202 { workflowId }` acceptance.
Protected Realms do not offer self-join; an owner admits an account through `POST /v1/realms/{realmId}/members`.
Resource roles do not create membership or a My Realms entry.

After an accepted self join or leave, the web interface refreshes `GET /v1/realms/{realmId}/members/me` and
`GET /v1/realms/{realmId}/participation` at most four times per refresh. Acceptance alone never means that the
membership changed. An unsettled or unavailable result keeps a pending state with a manual read retry; that
retry does not resend a command. A denied or hidden read is not an empty membership. Settlement invalidates
My Realms and the carrying Space's independent follow read. No workflow-status endpoint is introduced.

The follow control uses only `GET/PUT/DELETE /v1/follows/{spaceId}` through the shared Library interface.
Leave never unfollows, and an explicit unfollow remains authoritative when a later native join workflow applies
its implied Space follow. There is no Realm follow. A native leave denial remains a denial; the interface does
not transfer ownership or introduce a separate holder authority.

## Account erasure

The account-partition `party_locator` projects the committing ban, membership-operation and curator-verdict
events. The migration backfills existing records. Each locator names the source's exact owner-partition key;
source rows remain authoritative. Each locator effect locks the account's `community.erasure_fence` row in the
same transaction as its locator write. A pre-close locator is visible to later pages; a post-close effect writes no
locator, records an Access late item, minimizes its source and resolves the late item after that source commit. The
community participant closes the fence before paging. Each locator effect adds one locked point read, or one insert
for an account's first locator; closing the fence is one statement. Erasure runs as the platform under the committed
community erasure obligation, without restoring an initiator or holding a connection or transaction across
partitions.

`eraseAccountCommunityRecordsPage` reads at most 50 locator keys and applies these dispositions:

- Delete bans against the erased account: its identity can never return or be reused. Access owns its denials.
- Set the actor of bans issued by the account to null, preserving the ban. Empty reasons immediately when the ban
  began at least 183 days before the account's erasure T. More recent reasons are the single retention exception:
  store `community.realm_ban`, field `reason`, purpose complaint handling under Regulation (EU) 2022/2065,
  Article 20, expiry each ban's start plus 183 days. `reasonsKeptUntil` reports the latest expiry on a page;
  the participant folds it across pages.
- For terminal membership workflows, null every operation field naming the account and erase client, scopes,
  requested-by and authentication/delegation details. Read the workflow's current DBOS status using its committed
  creation id, and use `TERMINAL_WORKFLOW_STATUSES` from `work/retention.ts`. Known non-terminal workflows remain
  pending, with their operation and locator unchanged.
- A membership operation with no workflow history is pending until it is strictly older than the one-hour
  `MEMBERSHIP_OPERATION_ENQUEUE_GRACE_MS`. Evaluate this grace at each page's authoritative processing time,
  so a later page can finish pending work while the account's erasure T remains fixed.
- Set curator verdict actors to null, preserving their verdicts.

The creating request commits the membership operation and enqueues its workflow before answering. Its request
is bounded by `DEFAULT_REQUEST_DEADLINE_MS`, far below one hour. Workflow retention deletes only terminal
workflows, at least seven days after completion. A row without history past the grace therefore either finished
long ago or was never enqueued. A later enqueue can only come from an idempotent retry of the creating command
or a ban resuming removal with its durable key. `loadOperation` refuses operations whose account or actor fields
are null, so authorization fails closed before any reservation.

Handled locator rows are deleted except `ban_actor`, which stays until the reason expiry purge handles it.
`purgeAccountBanReasonsPage` seeks at most 50 `ban_actor` keys due at or before `asOf`, ordered by `due_at`.
It empties each reason at that ban's own expiry, leaves the ban in place, removes the locator and reports the
earliest remaining expiry as `nextDueAt`.

### Erase account community records and expire ban reasons

- Touches: one account-partition primary-key range of at most 50 locator keys; one source point update or delete
  per key, plus one primary-key operation read and one primary-key DBOS status read per membership operation.
  Locator deletion and the earliest remaining ban expiry are account-partition commands or indexed seeks.
- Bound: rows and statements are linear in the page, at most 50 keys; blocks are O(k log B). Total work is linear
  in the account's own records and independent of other Realms' bans, operations and verdicts.
- Growth check: `test/community/account-erasure-records.test.ts`, “an account community record erasure page stays
  within its bound as other Realms' bans, operations and verdicts grow”, with a constant page at 256, 1024 and
  4096 unrelated Realms.
- Fence cost: each party-locator effect adds one locked account-key read, or one first-account insert; closing is
  one statement. Rows and statements stay constant per effect, with logarithmic blocks in accounts per partition.

## Realm home shelf

The Space and Realm home adopts the reach-every-item and curate-existing-subject slices from
[the community design](../../../../docs/research/content-realms-spaces-design.md). Boards and publications retain
separate native cursors and explicit Load more actions, with fixed windows of 20 boards and 12 publications.
An empty window with a continuation is not an empty directory. Continuation denial, dependency failure and expired
cursors have distinct visible states; only an explicit reload restarts a list. Cursors retain their original
credential mode and native viewer binding. The existing bounded subject-summary reads are reused without an
additional publication-head read per card.

Curation uses `POST /v1/realms/{realmId}/publications` with `{subjectId}`, or the existing `:withdraw` and `:reject`
commands. Native `realm:publish` and subject readability authorize each command, including receipt replay.
Membership, `realm:manage`, ownership elsewhere and Context editorial authority never substitute for that check.
Loaded publication IDs supply current-head CAS; returned decision heads permit an explicit republish during the
visit. An uncertain reply retains the exact action, subject, expected head and request key for retry. A native
409/412 reads that subject's currently adopted head once and requires an explicit decision before retry with a new
key. A withdrawn, rejected or unreadable head is not exposed by the existing point read; the interface offers a
truthful reload state instead of inventing a head or silently overwriting another curator's decision.

A confirmed decision updates the same subject on this Realm shelf. It never changes Global identity, ownership,
facts or Context grants. Subject links retain their canonical Global destination and explain that fallback until
the actual [Semantic Realm-page binding](../../../../docs/subject-pages.md#realm-context) is delivered. A Realm query
parameter or a raw Context override is not a substitute for that binding.

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

## Addressed community setup

The served `/realms/new` setup entry launches a Space home through the ordinary Space creation,
address, Realm creation/settings, board-scheme and first-board commands. The Space home links to
setup only after a private current viewer-action read permits a relevant operation; the personal
Realms page also exposes the creation entry. The existing home regions remain separate.

Setup resolves an existing readable Context by its ID and existing `skos:ConceptScheme` and
`skos:Concept` subjects by their IDs. It shows their returned labels before selection. Realm
creation grants neither Context nor Global authority and creates no membership. Scheme membership,
participation and all command authority remain current server checks, never client certificates.

Each step uses its own command key and returned IDs. Space address, Realm settings and scheme
writes use the returned revision as `If-Match`. An uncertain response retains the entire original
command and key for replay. A definite conflict offers an explicit current-head refresh while
retaining created identities and entered values for review before the next command. A saved
address links to the actual Space home; a returned first-board ID links to that board. Setup does
not define role removal or succession policy.

The setup snapshot performs at most a Space point read, its readable carried Realm point read,
and one viewer-action batch of at most two resources. Each selection is one existing point read;
there is no catalogue, grant, membership or descendant scan and no per-card request fanout.

## Cost

| Operation                                                    | Touches                                                                                                                                                                                                                                                                                           | Bound                                                                                                                                                                                                          | Growth check                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create Space                                                 | Global admission and authorization; one Space insert, first revision insert, creation receipt and fixed native grant initialization in the Space partition.                                                                                                                                       | Constant rows and statements; logarithmic blocks in partition and Space population.                                                                                                                            | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                              |
| Update Space                                                 | Space authorization and exact head read; one revision insert and head compare-and-set, with receipt in the Space partition.                                                                                                                                                                       | Constant rows and statements; logarithmic blocks in partition and revision population.                                                                                                                         | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                              |
| Read Space with its carried Realm                            | Space read and authorization; exact head read, one carried-Realm slot lookup, and at most one Realm head read with its ordinary read authorization.                                                                                                                                               | Constant rows and statements; logarithmic blocks in the Space and Realm indexes.                                                                                                                               | `test/community/growth-space.test.ts`: “Space ${operation} stays bounded at 256, 1024 and 4096 Spaces and their revisions”.                                                                                                                                                                                              |
| Public Space eligibility                                     | One prepared Space point read and one current Space/head verification at Access's authoritative time.                                                                                                                                                                                             | Constant rows and statements; logarithmic blocks in the Space indexes.                                                                                                                                         | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                   |
| Claim or change Space address                                | Routed handle point read; pending claim write; Space head read, revision insert and compare-and-set; address activation and, on change, reservation of the old claim. Each phase is a single-partition command.                                                                                   | Constant rows and statements per step; logarithmic blocks in address, Space and handle indexes.                                                                                                                | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                   |
| Resolve Space address                                        | Active address point read followed by the Space's normal read authorization and exact head read.                                                                                                                                                                                                  | Constant rows and statements; logarithmic blocks in address and Space indexes.                                                                                                                                 | `test/community/growth-space-address.test.ts`: “address claim, change and resolve stay bounded as addresses, Spaces and handles grow”.                                                                                                                                                                                   |
| Create Realm                                                 | Shared admission for Global, host Space and Context checks; exact host and slot reads; prepared Context evidence and verification; Realm identity, first revision, receipt and fixed grant initialization in the host partition.                                                                  | Constant rows and statements; logarithmic blocks in the host partition, plus bounded Access checks.                                                                                                            | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                     |
| Update Realm                                                 | Realm authorization and exact head read; supplied Context adds one prepared evidence read and point verification; one revision insert and head compare-and-set.                                                                                                                                   | Constant rows and statements; logarithmic blocks in the Realm partition, plus bounded Access checks.                                                                                                           | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                     |
| Read Realm                                                   | Exact Realm head read during public eligibility; protected reads also evaluate the native `realm:read` grant.                                                                                                                                                                                     | Constant domain rows and statements; logarithmic blocks, plus bounded Access checks for protected reads.                                                                                                       | `test/community/growth-realm.test.ts`: “Realm ${operation} stays bounded across growth scales ${scales.join(', ')}”.                                                                                                                                                                                                     |
| Publish, withdraw or reject a publication                    | Admission and Realm authorization; exact subject-slot and current-head reads; one append-only publication record and slot/head change in the Realm partition, with receipt.                                                                                                                       | Constant rows and statements per command; logarithmic blocks in Realm and subject indexes.                                                                                                                     | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”.                                                                                                                                                                           |
| Read or list publications                                    | Read one subject's current publication slot/history or keyset-page a fixed limit of Realm publications, with the corresponding exact Realm and subject reads.                                                                                                                                     | Constant rows for a point read; linear rows in page limit for a list; logarithmic blocks in the relevant indexes.                                                                                              | `test/community/growth-publication.test.ts`: “publication writes and pages stay within their bound across growth scales ${scales.join(', ')}”.                                                                                                                                                                           |
| Set or read board scheme                                     | Admission for Realm management and subject eligibility; Realm head and Semantic subject/type point reads; setting appends one revision and compare-and-sets the head, while reading uses the head seek.                                                                                           | Constant rows and statements; logarithmic blocks in Realm and subject indexes, plus bounded Access checks.                                                                                                     | `test/community/board-scheme.test.ts`: `Realm board scheme set and read`.                                                                                                                                                                                                                                                |
| Publish membership, read terminal or change, or prove a role | Publish reads the Realm and opens or closes one membership interval, with at most one terminal insert. Terminal/change reads use one primary-key point read; role proof uses two membership index seeks and the Realm existence point.                                                            | Constant rows and statements per operation; logarithmic blocks in Realm membership indexes, plus bounded Access.                                                                                               | `test/community/growth-membership.test.ts`: “publish, terminal reads and role proofs stay within their bound as Realms and members grow”.                                                                                                                                                                                |
| Read current Realm membership                                | One unique `realm_member_open` index point read filtered at T; closed history does not widen the lookup.                                                                                                                                                                                          | One row and statement; logarithmic blocks in the Realm's membership history, including closed intervals.                                                                                                       | `test/community/growth-membership-history.test.ts`: “current membership is one index point read as the same account and Realm accumulate closed intervals”.                                                                                                                                                              |
| List own Realms                                              | Keyset-read at most 80 caller-route inverse rows, then confirm each candidate with one current `realm_member` primary-key read.                                                                                                                                                                   | At most 160 rows and a constant number of statements; logarithmic blocks in the inverse and membership indexes.                                                                                                | `test/community/own-realms.test.ts`: “own Realm pages use confirmed memberships, signed cursors and bounded inverse scans”.                                                                                                                                                                                              |
| List Realm and Space sitemap pages                           | Keyset-read at most four candidates per requested item (limit at most 1,000); each eligible item reads its exact head and related Realm/board slot as applicable. Skipped protected or inactive candidates remain bounded.                                                                        | Linear rows in page limit with at most four times the limit candidates; logarithmic blocks in feed indexes.                                                                                                    | `test/community/growth-sitemap.test.ts`: “Realm sitemap page stays within its bound as listed items grow”; “Space sitemap page stays within its bound as listed items grow”; “Realm sitemap page stays within its bound as protected Realms grow”; “Space sitemap page stays within its bound as protected Realms grow”. |
| Check Realm participation or ensure its member grant         | Participation checks `realm:participate`, the independent `realm:read` eligibility and one exact Realm head at shared T. Grant ensure reads the exact Realm head and idempotently inserts the member-group grant in the command.                                                                  | Constant rows and statements; logarithmic blocks, plus bounded Access membership proof.                                                                                                                        | `test/community/participation.test.ts`: “Realm participation stays bounded as Realms, members and grants grow”.                                                                                                                                                                                                          |
| Join a Realm                                                 | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; reserve and publish workflow steps restore the initiator; follow is one point upsert on the member account partition. Publication rechecks the ban.                                                    | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Join a Realm has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                                    |
| Leave a Realm                                                | Acceptance command reads the Realm and current-ban key and inserts one operation and receipt; reserve, publish and release steps restore the initiator. No follow is written or removed.                                                                                                          | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Leave a Realm has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                                   |
| Add a Realm member                                           | Acceptance command reads the Realm and current-ban key, inserts one operation and receipt; workflow reserves and publishes with initiator restoration, ensures the protected member grant, and upserts the member's follow point.                                                                 | Constant rows and statements per step; logarithmic blocks, plus bounded Access and initiator restoration; independent of member history.                                                                       | `test/community/growth-join.test.ts`: “Add a Realm member has constant rows and statements as Realms and its members grow”.                                                                                                                                                                                              |
| Read Realm votes                                             | One primary-key read of `community.realm` per requested Realm, with one statement per partition.                                                                                                                                                                                                  | Linear rows and statements in the number of requested Realms; logarithmic blocks per Realm.                                                                                                                    | `test/community/realm-votes.test.ts`: `Read Realm votes`.                                                                                                                                                                                                                                                                |
| Ban, unban or list current bans                              | Ban opens the Realm ban record and two identity denials, checks the owner/moderator grant keys and probes current membership; an existing member also gets a removal operation/workflow. Unban closes the record and denials. Listing keyset-reads at most L current bans plus one lookahead row. | Ban and unban have constant rows and statements; listing has linear rows in L and constant statements. Logarithmic blocks in Realm and ban indexes, plus bounded Access and removal workflow where applicable. | `test/community/growth-ban.test.ts`: `Realm ban, unban and list`.                                                                                                                                                                                                                                                        |

A is bounded Access admission and permission evaluation. Each `runCommand` phase is a single-partition transaction. Fixed request, page and change limits are inputs; no operation above depends on scanning unrelated history. Bounds describe database rows, statements and indexed blocks, not wall-clock latency or engine posting-list work.

## Public Realm discussion discovery

Community owns Popular and Trending. Their adopted definition is public discussion starts in the previous 30 and
1 complete UTC days respectively, ordered count descending then Realm ID ascending, omitting zero. Trending means
recent volume. Membership, unique people, votes, views and population normalization are not inputs. Later public
cards expose no counts and use null avatars/initials: there is no Realm/Space avatar-selection authority, and an
owner's photo is not a substitute. The aggregate and public route are separate, pending delivery.

The delivered source is Content's native `realm-discovery.changed.v1` catalogue entry and per-thread contribution.
`prepareRealmDiscoverySource` in `discovery-source.ts` verifies explicit public Realm state and independent anonymous
`realm:read` and host `space:read` at the originating command T. Access evidence and exact routed anchor reads finish
before the thread command opens its home. Realm `discovery_epoch` changes durably with visibility/state/host changes;
metadata-only head edits retain it. A return from protected visibility starts a new epoch. An original private
creation can never acquire qualification on replay, publication or delayed delivery. Epoch initialization does not
scan old content or infer historical publicity. The source's original epoch never changes.

The exact source read/apply preparation contract is exported by Content's `discovery.ts` as `DiscoverySourceFact`,
`readDiscoverySource` and `prepareDiscoverySourceApply`, with `DiscoveryDelta` defined by the closed native schema.
It supplies source version/state, not current rank eligibility. The aggregate must independently validate the current
Realm/Space binding and epoch; original-public evidence alone cannot authorize current disclosure.

Content's `discovery-mutation.ts` now supplies the outer native preparation/fence/acknowledgement/effect/outcome
phases for point deletion/takedown, the existing bounded author-erasure page, post restoration and appeal reversal.
`DiscoveryOperationReference` is exactly `(route, intent, generation)`; `readDiscoveryOperation` and
`readDiscoveryOutcome` read the committed source preparation and guarded native outcome. `commitDiscoveryFence`
accepts only that reference and reads its actual preparation before entering Realm home. `projectDiscoveryOutcome`
reads actual terminal source evidence, assigns absolute versioned contribution or board state and resolves just its
exact fence. It accepts no success assertion. Outbox envelopes are verified by the registered Content effect.

`readRealmDiscoveryGate(client, realmId)` supplies `{realm_epoch, generation, settled}` for one exact routed key.
`readRealmDiscoveryChanges(pool, {realmId, afterGeneration, limit, deadline})` is the additive internal consumer
interface. Its exported `RealmDiscoveryChangeValue` is the closed union of thread absolute `DiscoverySourceFact`,
board `{boardId, sourceVersion, published}`, epoch, and gate `{settled}` records. Each
`RealmDiscoveryCommittedChange` contains `realmId`, `realmEpoch`, decimal `generation` and `previousGeneration`,
the actual native executor `transactionId`, and `value`. `RealmDiscoveryChangePage` contains `changes`, the consistent
native `head` gate (or null for an absent Realm), and `next`. Generation frontiers are internal decimal strings,
never public cursors. Limits are integers 1–50. Invalid input throws. The reader checks native partition ownership
and deadline, then reads at most that many committed records in ascending generation and the head in one released
repeatable-read home snapshot. `next` is the last returned generation only while more committed work exists;
otherwise null. Missing log work below the head is unavailable, never invented empty success. Partition moves,
fencing, transport failures and deadlines remain native errors. This mechanical read supplies no person permission.

The append-only `realm_discovery_change` log is keyed `(route, realm_id, generation)` and has no expiry or pruning.
New Realm generations start at zero. Every actual mirrored thread/board change, exact fence install/resolution and
epoch transition appends a record in its original Realm command and advances the Realm generation by exactly one,
with the preceding committed generation recorded explicitly. Multiple records in a command have consecutive
predecessors and the same executor transaction id. Epoch transitions never reset this frontier. Repeated versions,
authorized replay and repeated fence operations append nothing. All producer commands lock the native Realm row
before mirror/fence writes. Deferred native SQL triggers append after the executor callback supplies its actual
transaction id; failure rolls back the original mutation too. A fact plus exact gate resolution commits atomically.
The native changed event is only a Realm/epoch wake hint. Committed log reads are the evidence.

The forward migration neither scans old threads nor invents historical log records or predecessors. A pre-log
Realm whose generation already advanced without retained log evidence stays unavailable on that missing range;
consumers must never guess a baseline from its mirrored rows. New deployment activity uses the zero-based log.

The consumer must read this genuine log through its real pool, require its local `appliedGeneration` to equal each
record's `previousGeneration`, enforce original/current epoch rules and native source-version deduplication, and
assign absolute states. Repeated old records are no-effect; gaps or conflicting predecessors remain unavailable
and retry the native read. It preserves its exact checked input across that released read and its own home write.
A step consumes at most 50 records. Epoch events reset eligibility without scanning sources. A board changes only
its eligibility and at most 31 buckets; thread caches retain original identity/day/absolute contribution even while
board eligibility is false. Old-epoch cleanup and expiry are independently bounded; neither log records nor timers
confer permission. No sourceVersion is a generation, and no raw delta change is a count to sum.

Pending or mismatched generations are unavailable. The later consumer must apply native facts to its bounded
buckets before advancing its generation; disclosure requires equality with the current settled native gate,
matching epoch, current rollover and independent current anonymous Realm/Space/lifecycle/publication checks before
and at final disclosure. Mirrored thread/board facts contain no person identity, bodies or public count. The
aggregate never calls source abort, changes source phases or resolves fences. Aggregate and public API ownership
remain separate from this producer.

Same-home container lifecycle writers are covered by database guards in the forward discovery migration:
Realm visibility/state/host changes advance its epoch and discovery generation atomically; Space state changes
advance the epoch/generation of its one exact native Realm slot through `(route, space_id)`. Metadata edits retain
them. Every same-home lifecycle command must call the delivered `bindRealmDiscoveryCommand(tx)` in its native
command body, before commit, so the deferred epoch log uses that executor's transaction id. Existing Realm/Space
commands do this; lifecycle writers delivered separately must consume this hook. An unbound epoch writer fails
closed and cannot commit an unlogged state change. `readRealmDiscoveryEpoch(tx, realmId)` is the exported same-home binding read and rejects another partition.
The container lifecycle owner must retain the Context pointer and original Space binding, use these ordinary native
state writers, and check lifecycle/publication before and at final disclosure. No new container-lifecycle files are
changed here, and no removed-container Global fallback is introduced. Readable orphan resources remain distinct
from removed resources. A restored container starts a new epoch; old contributions do not revive.

Preparation, fences and outcome acknowledgements each release their connection before the next home. Source
application and ABORTED recovery compete on the same source operation row, so an aborted generation cannot later
apply and an applied winner cannot clear as abort. Terminal fence tombstones survive delayed installation. Only
terminal unprojected source operations are recovered, 50 indexed due keys per partition step in the existing native collection
step. Unknown/live source outcomes remain pending; there is no timeout-based fence clearance or new scheduler.

Source qualification, epoch changes and source invalidation touch exact routed keys with constant rows/statements
plus bounded native Access work. Later aggregation must use at most 31 day-bucket keys per affected board, durable
bounded pages for multi-board changes, and O(changes log R) rank maintenance. Existing growth evidence remains for
integration. Public aggregate/endpoint delivery is still a separate consumer task.
