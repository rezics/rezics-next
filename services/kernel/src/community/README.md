# Community

A Space is the stable, routed identity for a future Realm (community) or Zone (site).
Its metadata is an append-only revision chain; the Space points to its current head.
This module provides commands and point reads. HTTP composition belongs to a later module change.

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
It returns metadata without implying permission. Callers compose Access `space:read` with
`spaceReadEligibility`, which prepares non-null domain evidence and verifies the current active
Space and head at Access's authoritative time. Missing domain evidence denies public reading.

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

`community.realm.owner` grants only `realm:read` and `realm:manage`. The role template
has no per-resource visibility condition, so Realm creation installs no standing role.
`realmReadEligibility` instead supplies anonymous public eligibility only while the
current Realm is public. `readRealm(deps, actor, realmId, { deadline })` performs the
head read inside that eligibility verification at Access's authoritative T. A protected
Realm requires a native `realm:read` grant; denied and missing reads both return null.

## Cost

A is Access's bounded admission and permission evaluation; C is a partition-local `runCommand`
transaction. Access grant initialization uses fixed role templates and point inserts. R denotes
rows in the relevant partition. See [Access Cost](../access/README.md#cost) for its account and
grant lookup bounds.

| Operation          | Touches                                                                                                                                                    | Bound                                     | Growth check                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Create Space       | One admission read and Global parent check (A); two inserts, a same-transaction creation proof and native grant initialization (C), in the Space partition | O(1) rows and statements; O(log R) blocks | `growth-space.test.ts`: create at 256, 2048 and 16384 other Spaces and revisions |
| Update Space       | A on the Space with one point read joining its head; one revision insert and one head compare-and-set (C)                                                  | O(1) rows and statements; O(log R) blocks | `growth-space.test.ts`: update a fixed probe at the same scales                  |
| Read Space         | One routed point read joining the exact head revision                                                                                                      | O(1) rows and statements; O(log R) blocks | `growth-space.test.ts`: read a fixed probe at the same scales                    |
| Public eligibility | One prepared point read and one current point verification through Access                                                                                  | O(1) rows and statements; O(log R) blocks | Uses the same point-read shape                                                   |

The growth checks use `checkGrowth` with other identities and their revisions growing around a
fixed probe, and require zero sequential scans on community relations. Metadata byte sizes are
bounded by the database character limits. Revision and predecessor lookups use exact routed keys;
no operation walks revision history or counts Spaces. Command serialization uses a partition-local
position counter.

| Operation    | Touches                                                                                                                                                                                                                                                                | Bound                                                                        | Growth check                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Create Realm | One admission observation shared by Global parent, Space and Context checks; one host point read and unique slot probe, prepared Context evidence and one Context verification at T; two inserts, a creation proof and grant initialization in the Space partition (C) | O(1) rows and statements; O(log R) blocks, plus A                            | `growth-realm.test.ts`: create at 256, 2048 and 16384 other Realms           |
| Update Realm | A on the Realm and one exact head read; a supplied Context adds its prepared evidence and point verification at T; one revision insert and head compare-and-set (C)                                                                                                    | O(1) rows and statements; O(log R) blocks, plus A                            | `growth-realm.test.ts`: update a fixed probe at the same scales              |
| Read Realm   | One exact head read during public eligibility verification; protected reads require A's grant branch                                                                                                                                                                   | O(1) domain rows and statements; O(log R) blocks, plus A for protected reads | `growth-realm.test.ts`: public and protected fixed probes at the same scales |

A Realm publishes subjects into one slot per subject. The record history is append-only and the head
names the current record. `publish`, `withdraw` and `reject` require `realm:publish` on that Realm.
The action is not mounted on the Realm role template; the caller grants it to a moderator. Publishing
confers no ownership and writes no access grant, resource initialization or semantic row on the subject
or the Global Context.

The anchor admits the actor once, then at T reads the active Realm and requires the subject to exist
and pass `subjectReadEligibility`. An empty slot takes no `expectedHead`. An occupied slot moves only
from that head. Withdraw and reject append a record and move the same head, so the slot leaves the
adopted keyset in the transaction that writes it.

`subject_revision_id` is null. The subject point reads at T (`subject-public-evidence.sql` and
`subject-exists.sql`) expose no revision. `readSubject` exposes a monotonic integer `revision`, not a
revision id.

`listPublications` seeks the Realm's adopted heads. Every returned item passes final disclosure:
`realm:read` for the Realm, including the public floor or a grant when the Realm is protected, and
`subjectReadEligibility` for the subject at one snapshot T. `readPublication` returns one adopted head
under those same checks. A protected Realm that the actor cannot read is indistinguishable from absence.

| Operation                   | Touches                                                                                                                                            | Bound                                          | Growth check                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Publish, withdraw or reject | One admission observation, one Realm point read and one subject point read at T, then one record insert and one head upsert in the Realm partition | O(1) rows, O(log R) blocks, plus A             | `growth-publication.test.ts`: a fixed probe at 256, 2048 and 16384 publications on other Realms and subjects |
| List or read publications   | One keyset seek of L adopted heads plus final disclosure of the Realm and each subject; no count or offset                                         | O(L * (conditions + chain)); O(1) for one head | `growth-publication.test.ts`: the probe Realm and page stay fixed at the same scales                         |

A Realm's `boardSchemeId` is initially null. `setBoardScheme` requires `realm:manage`,
reads the proposed subject through Semantic's own subject/statement reader and
`subjectReadEligibility` at the command's T, and accepts only `skos:ConceptScheme`.
It appends a revision and compares the expected head before updating the identity.
Metadata-only revisions inherit the scheme from their predecessor. The Realm reader
in `board-scheme.ts` includes the scheme in its exact head read, including HTTP reads.
`PUT /v1/realms/{realmId}/boardScheme` requires `If-Match`, `Idempotency-Key`, and
`{ schemeId }`. Board concepts remain ordinary `skos:Concept` subjects linked by
`skos:inScheme`; Semantic has no per-Context scheme table.

| Operation             | Touches                                                                                                                                                                                                                                                                | Bound                                             | Growth check                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set/read board scheme | One admission observation shared by Realm management and subject eligibility; one Realm head point read and Semantic's subject/type read at T; one revision insert and head compare-and-set in the Realm partition. Reading includes the scheme in the Realm head seek | O(1) rows and statements; O(log R) blocks, plus A | `board-scheme.test.ts`: fixed Realm and scheme at 2048, 8192 and 32768 other Realms and subjects; constant rows/statements and zero sequential scans on Realm and subject identities/revisions |

The board scheme HTTP tests use genuine Auth-issued tokens and production Access.
The kernel does not mount `account:suspend`, so the suspended-account persona is
omitted rather than simulated by a database state mutation.
