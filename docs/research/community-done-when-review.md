50253f81316a8e975d67971fb62ed42db3145c10

# Community completion review

The integrated layer is not yet complete against the stated HTTP outcome and persona requirements.
Resource creation, durable membership, board disclosure, publication and local Context decisions exist.
The largest concern is protected disclosure while a ban's membership removal is pending, or after an owner
adds the still-banned account again. Other gaps concern creation manifests, missing HTTP outcomes and inaccurate
evidence claims. These are static findings, not observed test failures.

## Evidence and interpretation

Reviewed on 28 October 2026. No tests, checks, check hosts or reference-project code were run.
All file and line references refer to the commit on the first line. The primary sources are the
[reviewed kernel source and tests](https://github.com/rezics/rezics-next/tree/50253f81316a8e975d67971fb62ed42db3145c10/services/kernel),
[shared HTTP outcome specifications](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/specs/community-outcomes.test.ts),
and [OpenAPI contract](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/contracts/openapi.json).
Their repository licence is [GNU AGPL version 3](https://github.com/rezics/rezics-next/blob/50253f81316a8e975d67971fb62ed42db3145c10/LICENSE).
No third-party implementation was copied or imported. This report is evidence for adoption, not a new contract.

`met` means existing assertions prove the persona's relevant permitted or denied outcome through HTTP.
It does not mean a test was executed during this review. `partial` identifies useful HTTP evidence with an
unproved clause or a source defect. `missing` means no matching HTTP outcome was found; it does not imply
the whole implementation is absent. Module tests and SQL inspection support findings but cannot earn `met`.
The community outcome entry point imports the shared specification; its driver calls `kernel.handle(Request)`
at `services/kernel/test/community/community-driver.ts:307`, with real authentication and native Access.

The following interpretations avoid inventing requirements or treating fixture names as proof:

- A Realm has a distinct resource id and head but shares its Space's route and physical partition. This is the explicit placement contract at `services/kernel/src/community/README.md:49`, not a missing separate database.
- A member means an actual Realm membership, not merely a fixture named `member`, an owner, or an independently read-granted account. A Realm moderator's separate Context grant is identified when used.
- A Realm ban is local. It is not account suspension and does not revoke unrelated Global authority. Public reads remaining open are intentional. Protected non-members below have no independent read grant; unbanned owners and moderators with such grants are authorized positive controls.
- The requested `new` listing is the mounted `newest` chronological sort; `oldest` is additional. A board resource references a SKOS Concept rather than sharing the Concept's id.
- `NOT EXISTS` means an independent absence-of-denial condition. Native Access expresses this with denial probes and `NOT bool_or` at `services/kernel/src/access/permission-check.sql:57` and `:73`; SQL spelling alone is not a defect.
- Context fallback and identity preservation concern subject values and identity fields. An increased aggregate subject revision after a local decision is allowed by the existing test at `services/kernel/test/community/realm-context.test.ts:355`.

## 1. Resources, Global creation authority and creation grants

- **Anonymous — met:** `services/kernel/test/community/space-http.test.ts: "anonymous reads a Space and cannot create or update one"` proves public head disclosure and denied Space creation; `specs/community-outcomes.test.ts: "anonymous reads public Realm boards and every thread sort but cannot create join react or post"` denies both creation routes. Anonymous cannot create a resource whose grants would need seeding.
- **Member — partial:** `services/kernel/test/community/space-http.test.ts: "an account granted space:create on the Global Context by platform governance creates a Space, reads it with its head and updates it with the current head"` and `services/kernel/test/community/realm-http.test.ts: "a Space owner granted realm:create creates the Space's one Realm with a classification Context and becomes its owner"` prove the authorized creator control. They do not establish an already joined member's authority matrix or HTTP-observed exact grant initialization, and both source commands omit the explicit manifest (`space.ts:180`, `realm.ts:311`).
- **Realm moderator — partial:** `specs/community-outcomes.test.ts: "Realm moderator takedown hides the thread from every sort and read without authority in another Realm"` proves scoped moderation, not Global creation. No HTTP creation control holds moderator status constant while granting/removing Global create and host management authority; the source requires these separately at `services/kernel/src/community/realm.ts:294` and `:303` and still uses the compatibility creation port at `:312`.
- **Banned account — missing:** no HTTP test creates or refuses Space/Realm creation as a Realm-banned, still-active account. `services/kernel/src/community/ban.ts:101` denies only Realm join/participation; creation checks Global authority at `services/kernel/src/community/space.ts:172` and `services/kernel/src/community/realm.ts:303`. Suspension tests cannot establish this scoped outcome.
- **Non-member of a protected Realm — partial:** `services/kernel/test/community/realm-http.test.ts: "anonymous reads a public Realm, while a protected Realm is the same 404 as a missing one for anonymous and for a non-member"` proves hidden resource reading; `specs/community-outcomes.test.ts: "creator owns Space and Realm and stale If-Match updates return 412"` denies outsider updates. Neither proves the outsider's independent Global creation authority or absence of creation side effects when that authority is missing (`services/kernel/src/community/realm.ts:303`).

Space creation allocates a routed id and revision, inserts both, and invokes `initializeResourceGrants` in
the same command (`services/kernel/src/community/space.ts:168`, `:196`, `:208`). Realm creation allocates a
different id on the Space route and initializes its template in the same transaction
(`services/kernel/src/community/realm.ts:288`, `:339`, `:364`). Templates seed creator ownership and standing
roles, not parent rights (`services/kernel/src/access/resource-roles.json:33`). HTTP head updates and stale
preconditions are covered by `specs/community-outcomes.test.ts: "creator owns Space and Realm and stale If-Match updates return 412"`.

Exact route, partition, initialization marker and grant-set assertions currently reside in module tests:
`services/kernel/test/community/space.test.ts: "Global create grant creates the first head and seeds only the Space owner and standing roles exactly once"`
and `services/kernel/test/community/realm.test.ts: "Space owner with Global realm:create mints a distinct Realm on the Space route with a head and only its owner role"`.
These prove implementation intent, not the required HTTP outcome. The Realm HTTP negative case tests a
non-owner, not a Space manager lacking Global `realm:create`.

There is also a concrete manifest integration gap. Space supplies `context.creation` at `space.ts:181`;
Realm does the same at `realm.ts:312`. Neither supplies the opaque manifest defined in
`services/kernel/src/access/creation-manifest.ts:25`. Access supports this legacy single-entry port
(`services/kernel/src/access/parent-creation.ts:195`, `:286`), but its all-entries-complete finalization
condition applies only to explicit manifests (`:300`). Both current commands do call the initializer;
this is not evidence of an existing uninitialized resource. It is incomplete adoption of the named creation
manifest contract and lacks a community HTTP regression proving its complete grant outcome.

## 2. Membership placement, join, leave, roles and bans

- **Anonymous — partial:** `services/kernel/test/community/join.test.ts: "anonymous, a suspended account and a non-owner adding a member are denied with no effect"` proves anonymous join is 401 with unchanged membership/workflow/follow counts. Anonymous ban/unban denial is covered by `services/kernel/test/community/ban.test.ts: "unban ends both denials without restoring membership, and a non-moderator, the banned account and anonymous cannot ban or unban"`. Anonymous leave, owner-add and role-grant/revoke outcomes are not covered by these assertions (`services/kernel/src/community/routes.ts:1193`, `:1237`).
- **Member — partial:** `specs/community-outcomes.test.ts: "member joins posts reacts and follows Space then settled leave preserves public participation but hides protected threads without unfollowing"` proves settled outcomes. `services/kernel/test/community/membership-transitions.test.ts: "each Realm membership transition gets its own workflow and settled owner additions grant protected access"` checks Realm membership, native group grants and account inverse after HTTP commands. Access-first leave before inverse release and member role escalation/refusal remain unproved through HTTP (`services/kernel/src/community/membership.ts:85`, `services/kernel/src/community/membership-close.sql:7`).
- **Realm moderator — partial:** `specs/community-outcomes.test.ts: "Realm moderator ban removes membership denies join participation and replay while public reads remain open"` and `services/kernel/test/community/ban.test.ts: "a ban of a non-member writes the denials and starts no workflow; a moderator without realm:ban cannot remove a member"` prove ban scope and denial. They do not cover moderator self-join/leave, role revocation effects, or protected reads while removal is pending (`services/kernel/src/community/work.ts:63`, `services/kernel/src/community/ban.ts:139`).
- **Banned account — partial:** `specs/community-outcomes.test.ts: "Realm moderator ban removes membership denies join participation and replay while public reads remain open"` proves immediate public-Realm participation/join denial, unchanged denied-write effects and settled membership removal. `services/kernel/test/community/own-realms.test.ts: "Space representations expose only the carried Realm the same viewer can read"` proves protected Realm/Space carry concealment after ban settlement. No HTTP test checks the pending protected window, independent read grants after ban, or owner re-addition of a still-banned target; source at `services/kernel/src/community/ban.ts:101` and `services/kernel/src/community/membership.ts:525` exposes these gaps.
- **Non-member of a protected Realm — partial:** `specs/community-outcomes.test.ts: "protected Realm non-member sees unknown-equivalent 404 and owner addition enables reading and posting"` proves concealed self-join and successful owner admission; `services/kernel/test/community/join.test.ts: "anonymous, a suspended account and a non-owner adding a member are denied with no effect"` proves unrelated management denial. There is no corresponding non-member leave or role-mutation/no-effect matrix (`services/kernel/src/community/routes.ts:1197`, `services/kernel/src/access/resource-roles.json:4`).

The ownership boundary is correctly structured: community imports Accounts' workflow and Library's follow
command (`services/kernel/src/community/work.ts:4`, `:8`). Membership rows use the Realm route
(`services/kernel/db/community/schema.sql:312`; `services/kernel/src/community/membership-open.sql:5`).
The join workflow durably enqueues and waits for Accounts membership, then runs the follow step;
it is not one cross-partition transaction (`services/kernel/src/community/work.ts:43`, `:63`).
`services/kernel/test/community/join.test.ts: "an active account joins a public Realm and follows its Space, and the owner adds a member to a protected Realm"`
asserts those named steps and final rows after HTTP commands. Leave has no follow step (`work.ts:71`).
Owner is an identity role, not a membership role (`services/kernel/src/community/membership.ts:94`);
Realm moderator is another native resource grant (`services/kernel/src/access/resource-roles.json:14`).
Existing HTTP grant/takedown tests and owner revocation in `own-realms.test.ts` demonstrate some native role
effects, but do not replace the missing member/moderator admission and escalation outcomes.

Ban writes explicit native denial records at the command's time for join and participation
(`services/kernel/src/community/ban.ts:101`), independent of positive grants. The ban HTTP tests inspect both
denials and show that unban closes them without restoring membership. Durable initiator restoration and
step-time revocation are tested only through the adapter in
`services/kernel/test/community/membership.test.ts: "a revoked, suspended or fenced initiator is denied at the workflow step with no effect"`;
there is no equivalent HTTP-initiated, interrupted community workflow test.

### Protected disclosure findings

An ordinary, never-admitted protected outsider is denied in the existing HTTP outcomes. No source path
was found that simply skips its Realm read check. The following banned-reader paths remain open by inspection:

- After ban commit, existing membership still authorizes `realm:read` until asynchronous removal publishes. The ban denies only join/participation (`ban.ts:101`) and enqueues removal after the ban command (`:139`); `services/kernel/src/community/realm.ts:186` checks only `realm:read`. Therefore a request made before removal can still return the protected Realm.
- The same permission is used for the Space's carried Realm id (`services/kernel/src/community/space.ts:144`), board/list disclosure (`services/kernel/src/content/boards.ts:135`), thread/post disclosure (`services/kernel/src/http/kernel.ts:172`) and publication reads (`services/kernel/src/community/publication.ts:153`). Existing resource/subject eligibility still applies; the ban itself does not close these read paths.
- An owner can request admission of a still-banned target: `/members` authorizes the initiator (`services/kernel/src/community/routes.ts:1244`), and membership publication restores that initiator's `realm:manage`, writes membership and ensures the protected member grant without checking the target's ban (`services/kernel/src/community/membership.ts:525`, `:563`, `:577`). After prior removal settles, this can recreate protected read access while self-join and participation remain denied.
- An independently granted owner/moderator read role also survives ordinary membership removal (`services/kernel/src/access/resource-roles.json:4`, `:14`). No protected banned-reader test addresses that combination. Independent grants explain legitimate unbanned non-member reads; fixture variable names alone must not turn those reads into claimed membership proof.

These are static disclosure findings, not reproduced responses. The settled ban check in `own-realms.test.ts`
does not exercise the pending window or re-admission. Content should add the HTTP boundary tests and close
the protected read/admission paths. If shared workflow or denial mechanics need changes, Accounts owns them.

## 3. SKOS boards, thread containers, ranking and cost

- **Anonymous — partial:** `specs/community-outcomes.test.ts: "anonymous reads public Realm boards and every thread sort but cannot create join react or post"` proves public board/thread reads, all sort routes and write denial. `services/kernel/test/content/board-hot-http.test.ts: "GET /v1/boards/{id}/threads?sort=hot lists by hot rank and sort=active by active rank, each with a keyset cursor bound to its sort"` proves stored-rank ordering and cursor binding. These do not prove an independent Lemmy formula or a correct complete written bound (`services/kernel/src/content/board-rank.ts:34`, `services/kernel/src/content/README.md:446`).
- **Member — partial:** `services/kernel/test/content/realm-boards.test.ts: "a settled protected Realm member reads its boards, threads and posts"` proves real protected membership and read/leave effects. Member reactions drive the hot-order change in `specs/community-outcomes.test.ts: "hot ranks use Realm vote weights after refresh and signed cursors page each sort without disclosure leaks"`, but the listings there are anonymous. Exact hot/active/newest ordering, cursor continuation and disclosure are not asserted as the member (`services/kernel/src/content/boards.ts:323`).
- **Realm moderator — partial:** `services/kernel/test/content/realm-boards.test.ts: "a Realm moderator creates one scheme Concept board and threads list on it"` proves Concept/scheme binding, a thread in that board, duplicate rejection and refusal of a Concept outside the scheme. `specs/community-outcomes.test.ts: "Realm moderator takedown hides the thread from every sort and read without authority in another Realm"` proves scoped removal; its sort lists are anonymous. Positive ranked pages/cursors as the moderator remain missing (`services/kernel/src/content/boards.ts:340`).
- **Banned account — partial:** `specs/community-outcomes.test.ts: "Realm moderator ban removes membership denies join participation and replay while public reads remain open"` checks public boards, thread reads and all sorts as the banned actor. It does not assert protected ban concealment on any sort; the pending/re-added membership read paths described above apply (`services/kernel/src/content/boards.ts:147`, `services/kernel/src/community/ban.ts:101`).
- **Non-member of a protected Realm — met:** `specs/community-outcomes.test.ts: "protected Realm non-member sees unknown-equivalent 404 and owner addition enables reading and posting"` checks Realm/board/thread and every sort against unknown-target responses. `services/kernel/test/content/realm-boards.test.ts: "protected Realm board listings and thread lists are the same 404 for anonymous and non-members"` adds the protected Realm board-list boundary. No positive ranking right is inferred for this denied persona.

Board creation checks `skos:Concept`, Realm scheme presence and `skos:inScheme`
(`services/kernel/src/content/board-create.ts:124`, `:157`), and creates a separate routed board referencing
that concept. Thread listings use that board container. The HTTP test above supplies the missing-SKOS-binding
negative control as well as the successful container outcome. Scheme updates themselves have HTTP evidence in
`services/kernel/test/community/board-scheme.test.ts: "a Realm owner sets an existing ConceptScheme, moving its head and retaining metadata and revision history"`.

The SQL rank function is `services/kernel/db/content/schema.sql:30`; the attributed Lemmy calculation also
exists in `services/kernel/src/content/board-rank.ts:34`. Refresh uses last activity for active and creation
time for hot (`board-rank.ts:136`). Active/hot use indexed rank keysets; newest uses a creation-time keyset
(`services/kernel/src/content/boards.ts:359`, `:376`, `:389`). No pinned upstream Lemmy source or independent
upstream comparison was found in this evidence. The HTTP stored-order comparison is not such a comparison.
The numeric refresh check is a module test:
`services/kernel/test/content/board-hot-refresh.test.ts: "one refresh sets Realm weighted scores and recomputes active and hot ranks"`.
Reply-driven active reordering is likewise module-level in
`services/kernel/test/content/board-ranking.test.ts: "a reply moves its thread activity and active listing uses the rank keyset cursor"`.
The shared HTTP test pages every sort but does not assert exact active/newest ordering against independent values.

There is a written hot bound, but it describes a seek of output page length L and refers to an unspecified
active-page bound (`services/kernel/src/content/README.md:444`). The implementation requests Q = 200
candidates for each sort regardless of L (`services/kernel/src/content/boards.ts:356`), discloses candidates,
and discloses returned entries again (`:417`, `:446`). The correct explanation must account for Q, final
disclosure, its bounded chain and authorization work, and short pages of hidden candidates. Fixed Q does
bound the implementation; it does not make the stated L-row touch count accurate. The candidate-only cost
row at `services/kernel/src/content/README.md:462` explicitly excludes the public disclosure path and still
calls it unfinished. It cannot serve as the complete newest/active public listing bound.

HTTP growth evidence exists in
`services/kernel/test/content/board-hot-http.test.ts: "the hot page stays within its bound as boards and threads grow"`
and `specs/community-outcomes.test.ts: "hot page and membership check have derived constant row and statement bounds at three population scales"`.
It does not establish all-sort, all-persona cost coverage. Existing module growth tests are supplementary.

## 4. Publication slots, heads and absence of Global authority

- **Anonymous — partial:** `services/kernel/test/community/publication-http.test.ts: "a Realm moderator publishes a subject, and anonymous lists and reads it in a public Realm"` proves public publication reads; `services/kernel/test/community/publication-http.test.ts: "a non-moderator and a stale head are denied with no effect, and protected publications are the same 404 to a non-member"` proves anonymous publish denial and protected list/read concealment. It does not send anonymous withdraw/reject or test a still-adopted subject becoming unreadable (`services/kernel/src/community/publication.ts:349`).
- **Member — missing:** no publication HTTP test establishes a settled ordinary Realm membership before reading/listing a protected publication or attempting publish/withdraw/reject. The protected positive controls at `services/kernel/test/community/publication-http.test.ts:558` are owner and independently granted moderator; the denied actor at `:518` is unrelated. Production requires `realm:publish` (`services/kernel/src/community/README.md:164`), which the member template lacks (`services/kernel/src/access/resource-roles.json:13`).
- **Realm moderator — partial:** `services/kernel/test/community/publication-http.test.ts: "a Realm moderator publishes a subject, and anonymous lists and reads it in a public Realm"` checks head, replay and unchanged native Access snapshots; `services/kernel/test/community/publication-http.test.ts: "withdraw and reject remove the publication from the next list and read, and nothing is granted on the subject or the Global Context"` covers moderator rejection. The full slot lifecycle and attempted Global subject/Context mutation are not exercised as moderator (`services/kernel/test/community/community-driver.ts:1120`).
- **Banned account — missing:** no HTTP publication list/read/write outcome uses a Realm-banned account. The public-readable outcome and protected concealment outcome are both absent for publications. Banning grants no publication-specific denial (`services/kernel/src/community/ban.ts:101`); publication checks `realm:publish` for commands and `realm:read` for reads (`services/kernel/src/community/README.md:164`, `services/kernel/src/community/publication.ts:160`). A ban alone must not be confused with suspension or removal of a separately granted publisher role.
- **Non-member of a protected Realm — partial:** `services/kernel/test/community/publication-http.test.ts: "a non-moderator and a stale head are denied with no effect, and protected publications are the same 404 to a non-member"` proves list/read 404 equivalence. Its refused mutations target a public Realm, so protected publish/withdraw/reject concealment and unchanged heads/effects are not proved (`services/kernel/test/community/publication-http.test.ts:496`, `:550`).

Owner controls prove the unique slot lifecycle in
`specs/community-outcomes.test.ts: "publication uses one unique slot across withdraw reject and re-publication and grants no Global subject rights"`,
and `services/kernel/test/community/publication-http.test.ts: "a publisher can re-publish a withdrawn or rejected subject from its current head"`.
The database keys one head by `(route, realm_id, subject_id)` (`services/kernel/db/community/schema.sql:493`).
HTTP occupied-slot and stale-head denials are covered by
`services/kernel/test/community/publication-http.test.ts: "publishing into an occupied slot without its head answers 409 to an authorized publisher"`
and `services/kernel/test/community/stale-head.test.ts: "authorized Space, Realm and publication commands reject only a stale head with 412"`.

No-new-ownership evidence is substantive: `accessSnapshot` includes role grants, direct grants and resource
initialization (`services/kernel/test/community/publication-http.test.ts:162`), and the HTTP commands leave
it unchanged. The shared outcome additionally denies candidate creation and subject takedown by the publisher,
checks unchanged Global subject representation and supplies the true subject-owner positive control.
It does not attempt an identity-field update or Global Context acceptance after publication. Those missing
HTTP authority outcomes should be added rather than describing candidate creation as an identity edit.

The README's final subject disclosure promise (`services/kernel/src/community/README.md:180`) is implemented
in `services/kernel/src/community/publication.ts:347` and `:395`. The test that removes an adopted subject and
checks omission/null uses direct module calls and SQL deletion:
`services/kernel/test/community/publication.test.ts: "a Realm's publication list is a keyset page whose every item passes final disclosure"` (`:463`).
No equivalent HTTP publication list/read check follows subject takedown while its slot remains adopted.
The shared HTTP test takes the subject down only after rejection, so cannot prove that case.

## 5. Realm Context decisions, Global fallback and identity

- **Anonymous — missing:** no anonymous HTTP Realm Context view/accept/reject outcome was found. The current decision helper defaults to moderator and its negative matrix enumerates only member/unrelated accounts (`services/kernel/test/community/realm-context.test.ts:303`, `:370`). Anonymous public-subject fallback and denied decisions need explicit HTTP assertions.
- **Member — missing:** `services/kernel/test/community/realm-context.test.ts: "a non-moderator member and an unrelated account cannot accept or reject in the Realm Context"` denies the actor called member, but setup grants it only direct `realm:read` (`:249`), without a membership workflow. No settled member proves local/fallback views, decision denial and unchanged Global identity as that actor.
- **Realm moderator — met:** `specs/community-outcomes.test.ts: "Realm Context accepts and rejects locally with Global fallback and unchanged global identity"` and `services/kernel/test/community/realm-context.test.ts: "Realm Context decisions preserve global identity, values and candidate decisions"` check HTTP local reject/accept, unaffected-property fallback, stable identity fields and Global decisions. `services/kernel/test/community/realm-context.test.ts: "a non-moderator member and an unrelated account cannot accept or reject in the Realm Context"` also denies this moderator Global accept/reject. The positive actor explicitly has both Realm and Context moderator grants (`community-driver.ts:546`; `realm-context.test.ts:247`).
- **Banned account — missing:** no HTTP Context outcome uses an active Realm-banned account. Realm ban affects join/participation (`services/kernel/src/community/ban.ts:101`), while Context authority is a separate native role (`services/kernel/src/access/resource-roles.json:29`). Tests must distinguish an ordinary banned account from one independently granted Context authority and check unchanged Global identity in either case.
- **Non-member of a protected Realm — partial:** `services/kernel/test/community/realm-context.test.ts: "a non-moderator member and an unrelated account cannot accept or reject in the Realm Context"` confirms the unrelated actor cannot read the protected Realm and cannot decide locally, with no effect. All local/Global view comparisons run through the default moderator (`:303`, `:368`), so this persona's own fallback and identity view are unproved.

Realm moderation does not itself confer Context authority. The production fixture deliberately grants
`semantic.context.moderator` separately, because a Context may serve multiple Realms
(`services/kernel/test/community/community-driver.ts:560`). The recommendation is to extend the HTTP
persona evidence while preserving that separation. Any defect in the semantic decision engine belongs to
the owning semantic Goal; this review does not propose changes to that engine.

## 6. Join's Library follow step and explicit unfollow precedence

- **Anonymous — met:** `services/kernel/test/community/join.test.ts: "anonymous, a suspended account and a non-owner adding a member are denied with no effect"` checks anonymous HTTP join denial against a footprint containing membership, Library follows and durable workflow counts (`:201`). No implied follow is produced by the refused join.
- **Member — partial:** `services/kernel/test/community/join.test.ts: "an active account joins a public Realm and follows its Space, and the owner adds a member to a protected Realm"` proves the named durable follow step and Space follow; `specs/community-outcomes.test.ts: "member joins posts reacts and follows Space then settled leave preserves public participation but hides protected threads without unfollowing"` preserves it on leave. No HTTP explicit Space unfollow is followed by join/rejoin or owner-add and settlement (`services/kernel/src/community/work.ts:67`).
- **Realm moderator — missing:** no HTTP join/follow outcome is run as a Realm moderator, with either absent follow or explicit unfollow. The same workflow invokes Library unconditionally after membership completion (`services/kernel/src/community/work.ts:63`); moderator status is not an exercised integration control.
- **Banned account — partial:** `services/kernel/test/community/ban.test.ts: "a Realm moderator bans an account: from T it cannot join or participate, an existing membership ends through the leave workflow, and public reads stay open"` checks that ban removal preserves the existing Space follow, and the shared ban outcome refuses rejoin. No explicit-unfollow state is tested across denied join, unban/rejoin or attempted owner-add (`services/kernel/src/community/work.ts:49`, `services/kernel/src/community/membership.ts:525`).
- **Non-member of a protected Realm — partial:** `specs/community-outcomes.test.ts: "protected Realm non-member sees unknown-equivalent 404 and owner addition enables reading and posting"` denies self-join, while the join HTTP test proves that owner-add follows the Space. Neither combines protected admission with a prior explicit Space unfollow or checks the denied outsider's unchanged follow state (`services/kernel/src/community/routes.ts:1157`, `services/kernel/src/community/work.ts:51`).

The integration calls Library's actual `followForMembership`, rather than writing follow storage itself
(`services/kernel/src/community/work.ts:49`). Library applies `intent: implied`, `reason: membership`
(`services/kernel/src/library/follows.ts:228`), and its conflict update excludes implied overwrites of an
existing same-type follow (`services/kernel/src/library/follow-store-apply.sql:21`). This is a sound ownership
pattern, but not the missing HTTP proof. The explicit-unfollow case exists only at module level in
`services/kernel/test/library/follows.test.ts: "a membership step follows a space and never overrides an explicit unfollow"`.
`services/kernel/test/library/personal-http.test.ts: "Space inference uses community reads and conceals a denied target like an unknown one"`
does perform HTTP Space follow/unfollow, but never subsequently joins a Realm. The smallest missing
integration is HTTP explicit unfollow, join/owner-add, workflow settlement and HTTP follow read showing
the same explicit unfollow; repeat through rejoin and durable retry without an extra follow effect.
Library owns precedence/storage defects if those new community outcomes reveal one.

## Claims and evidence that need correction

- The community README says `realm:publish` is not mounted on Realm roles (`services/kernel/src/community/README.md:165`), contradicting its own role list (`:65`) and `services/kernel/src/access/resource-roles.json:4`. Actual HTTP moderator publication proves it is mounted. Content should correct the prose to the implemented template contract.
- `services/kernel/test/community/space-http.test.ts: "an account without the grant, a suspended account and a stale head are denied with no effect and no disclosure"` does not suspend anyone; its comment says so at `:350`. `services/kernel/test/community/realm-http.test.ts: "a second Realm, a non-owner, a suspended account, an unreadable Context and a stale head are denied with no effect"` explicitly omits suspension at `:325`. Genuine suspension outcomes elsewhere do not make either title accurate, and never substitute for Realm-ban outcomes.
- `services/kernel/test/community/join.test.ts: "leave ends membership and its access before anything else and keeps the follow, a protected Realm cannot be self-joined, and replays create nothing new"` waits for settlement, then asks for steps under `realm:leave:<realm>:<account>` (`:480`). Production child ids are hashed `realm:membership:<digest>` (`services/kernel/src/community/work.ts:12`). Thus its ordering assertion is disconnected from the actual workflow; even a correct history lookup would not itself prove an HTTP read is denied before inverse release. This is present in the reviewed commit; no test failure was observed or claimed here.
- `services/kernel/test/community/realm.test.ts: "Space owner with Global realm:create mints a distinct Realm on the Space route with a head and only its owner role"` actually expects both standing and owner grants (`:232`). It is a module test, not HTTP grant proof.
- The shared publication title's broad Global-rights claim samples candidate creation and takedown. The helper named `edit` posts a candidate (`services/kernel/test/community/community-driver.ts:1120`), not a subject identity-field update. Snapshot equality is valid no-grant evidence; it is not an HTTP attempt to exercise every Global right.
- The Context negative test's member has a direct read grant, not membership (`services/kernel/test/community/realm-context.test.ts:249`). The protected publication loop's variable named member similarly ranges over owner/moderator (`services/kernel/test/community/publication-http.test.ts:558`). Neither supplies ordinary member coverage.
- `specs/community-outcomes.test.ts: "suspended account receives 401 on every community write with active positive controls"` does not enumerate Space address or board-scheme writes (`:548` onward). Those have separate HTTP tests, but the literal title overstates that one test's assertions.
- README behaviours with no complete HTTP proof are the exact creation grant/partition/manifest outcome, access-first leave before inverse release, delayed-step authority revocation, subject-ineligible publication disclosure, all-persona Context fallback, and complete active/newest ranking/cost. Module evidence for several exists as cited above. Space carried-Realm filtering is covered by `own-realms.test.ts`; only its pending-ban and re-admission cases are missing.

Existing acceptance tests must not be weakened to resolve these findings. Add the missing HTTP outcomes;
the owners of existing tests can address obsolete identifiers and overstated titles separately. No runtime,
test or frozen file was changed by this review.

## Gaps in priority order

1. Protected reads during pending ban removal can still disclose Realm, carried Realm id, boards, threads/posts and eligible publications; persona: banned account; evidence: `services/kernel/src/community/ban.ts:101`, `:139`, `realm.ts:186`, `services/kernel/src/http/kernel.ts:172`; smallest task: Content adds an HTTP ban test paused before membership removal, checks every read/list/sort against unknown targets, and closes the protected ban read boundary; Accounts owns any shared denial/workflow change.
2. Owner admission can recreate membership/read access for a still-banned target, and independently granted reads survive removal; persona: banned account; evidence: `services/kernel/src/community/routes.ts:1244`, `membership.ts:525`, `:577`, `services/kernel/src/access/resource-roles.json:14`; smallest task: Content adds HTTP owner-add-after-ban and banned-reader-role controls and makes its protected admission/disclosure enforce the ban; Accounts owns changes to common membership authorization if required.
3. Space and Realm creation use the compatibility port instead of the named explicit manifest; personas: all authenticated creation controls; evidence: `services/kernel/src/community/space.ts:181`, `realm.ts:312`, `services/kernel/src/access/parent-creation.ts:300`; smallest task: Content declares one-resource manifests for both commands and adds HTTP creation/replay/no-effect outcomes asserting routed heads, exact initialization and owner/standing grants; Accounts owns manifest internals.
4. Leave ordering lacks valid intermediate HTTP proof and its existing step-history lookup is obsolete; personas: member, moderator and ban-removal target; evidence: `services/kernel/test/community/join.test.ts:480`, `services/kernel/src/community/work.ts:12`; smallest task: Content adds an HTTP-initiated leave/removal test paused after Realm publication but before inverse release, asserting protected absence and unchanged follows; Accounts owns workflow instrumentation/defects, and the existing test owner handles its obsolete lookup without weakening it.
5. Explicit unfollow precedence is not tested through community HTTP workflows; personas: member, moderator, banned account after unban, and protected non-member admitted by owner; evidence: `services/kernel/test/library/follows.test.ts:409`, `services/kernel/src/community/work.ts:49`; smallest task: Content adds HTTP Space-unfollow then join/rejoin/owner-add/retry outcomes with unchanged explicit state and no extra follow effect, plus denied-join no-effect controls; Library owns any precedence defect.
6. Listing formula and order proof is incomplete: stored-rank comparison and module arithmetic do not establish upstream Lemmy parity or HTTP reply-driven active/newest order; personas: anonymous, member, moderator and public banned reader; evidence: `services/kernel/src/content/board-rank.ts:34`, `services/kernel/test/content/board-ranking.test.ts:425`, `services/kernel/test/content/board-hot-refresh.test.ts:479`; smallest task: Content records the intended upstream formula/version and adds independent expected hot/active/newest HTTP ordering and cursor outcomes with age/tie/reply/vote controls for readable personas.
7. The written public listing cost understates candidate touches and lacks complete active/newest disclosure bounds; personas: every readable persona, with denial controls for protected outsiders/banned readers; evidence: `services/kernel/src/content/README.md:444`, `:462`, `services/kernel/src/content/boards.ts:356`, `:446`; smallest task: Content documents Q = 200, bounded disclosure and final rechecks for every sort, and extends HTTP growth evidence to the uncovered sorts/authorization branches.
8. Creation permission coverage does not distinguish Global grants from Realm roles for each active persona; personas: member, moderator, Realm-banned account and protected outsider; evidence: `services/kernel/src/community/realm.ts:294`, `:303`, existing `realm-http.test.ts:322` omits missing-Global-grant control; smallest task: Content adds HTTP create positive/negative controls with Global grant, Space management and persona varied independently, verifying denied calls leave no resources, grants or receipts.
9. Membership role/admission and delayed authority evidence is incomplete; personas: anonymous, member, moderator and protected outsider; evidence: `services/kernel/src/community/membership.ts:85`, `services/kernel/test/community/membership.test.ts:862`, `services/kernel/src/community/routes.ts:1193`; smallest task: Content adds HTTP join/leave/add, forbidden membership-owner promotion, native role grant/revoke effects and accepted-workflow initiator-revocation outcomes; Accounts owns common role and durable initiator mechanics.
10. Publication has no actual member or Realm-banned persona matrix, incomplete anonymous/protected mutation denial and incomplete moderator lifecycle/Global mutation controls; personas: all five; evidence: `services/kernel/test/community/publication-http.test.ts:498`, `:518`, `:558`, `services/kernel/test/community/community-driver.ts:1120`; smallest task: Content adds HTTP publication list/read and authorized/denied lifecycle cases for real memberships and bans, asserting slot/head/no-effect and attempted Global identity/Context authority with independent positive controls; semantic authority defects belong to the semantic Goal.
11. Publication final subject disclosure is only module-proved when an adopted subject becomes unavailable; personas: all five, using their permitted/denied read branches; evidence: `services/kernel/src/community/README.md:180`, `services/kernel/test/community/publication.test.ts:463`; smallest task: Content publishes, takes down the subject through HTTP while leaving the slot adopted, then checks list omission/read absence and unchanged slot across personas.
12. Context fallback/identity evidence is moderator-only and the negative member fixture has no membership; personas: anonymous, actual member, Realm-banned account and protected outsider; evidence: `services/kernel/test/community/realm-context.test.ts:249`, `:303`, `:370`; smallest task: Content extends integrated HTTP Context scenarios with real membership/ban setup, per-actor local/Global reads and accept/reject controls, preserving separate Context grants; semantic decision defects belong to the semantic Goal.
13. Contract prose and evidence labels overclaim or contradict the implementation; personas: all readers of the completion evidence; evidence: `services/kernel/src/community/README.md:165`, `services/kernel/test/community/space-http.test.ts:350`, `realm-http.test.ts:325`, `realm.test.ts:232`, `realm-context.test.ts:249`; smallest task: Content corrects its publication/cost prose and adds accurately scoped HTTP evidence; owning test maintainers resolve existing misleading titles and the stale workflow reference without changing acceptance expectations.
