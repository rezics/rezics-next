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
