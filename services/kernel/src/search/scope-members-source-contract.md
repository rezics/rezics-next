# Members preparation Source contract

## Search declaration

`scope-members-source-declaration.ts` exports `MEMBERS_PREPARATION_SOURCE_DECLARATION`,
`MEMBERS_PREPARATION_SOURCE_PATHS`, `MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS`, and
`sumMembersPreparationSourceTerms`. The declaration is explicitly `incomplete`: it contains a finite known subtotal
and the body-derived path maxima, but has no `cost` field. A `WorkAllowance`, `WorkReceipt`, per-call ceiling or this
subtotal cannot be installed as `SelectedChildren.source`.

The shared axes are candidateKeys, nativeRows, identityMetadataRows, nativePoints, witnessKeys, statements, bytes,
emptySeeks and engineRequests. Library's existing `MEMBERS_PREPARATION_BRANCH_COST.sourceMetadata` is the one
priced whole prefix available to Search. Its producer documents 9 step reads, 5 Source metadata reads and 2 owner
fence reads. Their components are:

| Component           | candidateKeys | nativeRows | identityMetadataRows | nativePoints | witnessKeys | statements |      bytes | emptySeeks | engineRequests |
| ------------------- | ------------: | ---------: | -------------------: | -----------: | ----------: | ---------: | ---------: | ---------: | -------------: |
| 9 × step            |             0 |         18 |                    0 |           18 |           0 |          9 |  9,437,184 |         18 |              0 |
| 5 × Source metadata |             0 |         25 |                    0 |           25 |           0 |          5 | 10,485,760 |         25 |              0 |
| 2 × owner fence     |             0 |          2 |                    0 |            2 |           0 |          2 |      2,048 |          2 |              0 |
| Known subtotal      |             0 |         45 |                    0 |           45 |           0 |         16 | 19,924,992 |         45 |              0 |

These are the literals in `members-preparation-cost.ts`; the Search export sums that branch by name. They do not
price Search's nested scope work or any other owner. `scope-members-work-cost.ts` also names the actual query-meter
projections: point reads have 4 rows, 1 point, 1 statement, 1 empty seek and 512 bytes plus SQL and serialized
parameters; preparation reads have 32 rows, 4 points, 1 statement, 1 empty seek and 65,536 projected bytes; canonical
scope reads have 64 rows, 8 points, 1 statement, 1 empty seek and 65,536 projected bytes. A cold release body read
also has a size query and projects `6 × (compressed ? 1,073,741,824 : storedBytes) + 1,024` bytes, plus its SQL and
serialized parameters. These query ceilings are active only while `withMembersWorkBudget` is active, so they do not
price the three direct Library getters in the released Source body and are not a whole invocation quote.

## Reached body and finite path maxima

`MEMBERS_PREPARATION_SOURCE_PATHS` follows `readReleasedPreparationSource` and `advancePreparation`. The `id` and
`ordinal` branches are mutually exclusive. Each branch prepares one source and advances one bounded prefix. `id`
caps its candidate prefix at 2 and evaluates at most the first candidate. `ordinal` reads at most one raw row, checks
its terminal and earliest ordinal, then evaluates at most one subject. Evaluation runs two closure/currentness
passes. The closure is bounded by 100 raw keys; with the `ids.length + raw.keys.length <= 100` check, one pass has
at most 49 terminal lookups, 50 fact queries, 98 owner fact reads and 98 pinned-release reads. The earliest-ordinal
scan has at most 99 member probes. These are call maxima, not costs; nested native statement prices are still needed.

| Reached operation                    |     id path |     ordinal path | Derivation                                                                                  |
| ------------------------------------ | ----------: | ---------------: | ------------------------------------------------------------------------------------------- |
| `readWorkDefinition` calls           |          15 |               11 | Three direct getters; Search snapshot and order-currentness calls along the selected branch |
| `readMembersSnapshot` calls          |           8 |                4 | Prepare start/end, prefix start/end, plus four id-evaluation currentness checks             |
| Order currentness reads              |           4 |                2 | Before/after prepare and before/after the selected prefix                                   |
| `createSearchScopeSource.prepare`    |           1 |                1 | One preparation per released Source callback                                                |
| Selected prefix                      | 1 id prefix | 1 ordinal prefix | Definition sort chooses exactly one                                                         |
| Evaluated subjects                   |           1 |        at most 1 | Id chooses its first candidate; ordinal raw quota is 1                                      |
| `readPreparationScope` / owner fence |       2 / 2 |            2 / 2 | Before Search execution and after its final currentness read                                |

Each `readMembersSnapshot` also calls `readCollectionSourceWorkState`, reads the current `canonical_source_scope`
capture/revision, revalidates its identity observation and reads the owner fence. The id/ordinal counts above multiply
those calls. The evaluator retains one canonical group, repeats closure evidence before using a result, and reads at
most two owner candidates. A failed Source callback rolls back and closes its one released operational transaction;
a successful callback commits it. Those finishes are mutually exclusive. After the callback, the existing selected
native declarations separately cover one apply, failure association/write, or restart drain/reset/repair path. Do
not add those already-declared native statements to the Source field a second time.

The source declaration remains incomplete because the required owners have not supplied these finite child prices
or physical authority:

| Owner                                              | Body                                                                                                 | Missing from the nine axes                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library                                            | `MembersPreparation.readWorkDefinition` and retained release reconstruction                          | Current `NativeSourceIdentity`, current `CollectionSourceObservation`, cold release and header statement/row/point/byte bounds, same-client revalidation cost |
| Library                                            | `readCollectionSourceWorkState`, `createCollectionSource.prepare`, id prefix and raw ordinal prefix  | Per-call cost declarations and transitive native statement, row, point, empty-seek and byte bounds                                                            |
| Semantic                                           | `createIdentityScopedObservations.revalidate`                                                        | A finite child quote for the capture/revision fence, including reached failure and cleanup                                                                    |
| Search                                             | `readMembersSnapshot`, `membersTerminal`, `group`, `closure` facts queries and `firstMembersOrdinal` | Sum the direct query bounds and SQL/serialized-parameter byte projections across the path maxima                                                              |
| Library                                            | Owner fact providers, accepted release body reads and `readOwnerFilterCandidate`                     | Transitive native statements and the bounded fact/release byte projections over both closure passes                                                           |
| Core                                               | `runOperationalTransaction` around `readReleasedPreparationSource`                                   | Work-step setup, time/owner fences, and commit or rollback/connection cleanup cost                                                                            |
| Commerce successor with Library producer ownership | `MEMBERS_SELECTED_CHILDREN.source` and `checkMembersPreparationCompletion`                           | The complete `SelectedCost`, the installed source field, and final physical-source authority                                                                  |

`MEMBERS_SELECTED_CHILDREN` currently declares native children but no `source`. `SelectedInvocation.source` therefore
refuses before dispatch. `readWorkDefinition` also throws `dependency_unavailable` for a live retained episode, and
`checkMembersPreparationCompletion` currently returns `selected-runtime-final-source-physical-authority-unavailable`.
Keep preparation typed unavailable until those owners supply the missing declarations and authority. No allowance
transfer, refill, ledger, second runtime or scope admission follows from this static work.

## Same-client binding interface

Use the existing type homes and exact types:

```ts
import type { OperationalTransaction } from '../command/operational.ts';
import type {
  MembersPreparationWorkDefinition,
  PreparationDefinition,
  PreparationLocator,
} from '../library/members-preparation.ts';
import type { CollectionSourceObservation } from '../library/collection-source.ts';
import type { NativeSourceIdentity } from '../library/native-source-custody.ts';

export type MembersPreparationWorkContext = Readonly<{
  kind: 'members-preparation';
  tx: OperationalTransaction;
  locator: PreparationLocator;
}>;

MembersPreparation.readWorkDefinition(
  tx: OperationalTransaction,
  locator: PreparationLocator,
): Promise<MembersPreparationWorkDefinition | null>;

export type MembersPreparationWorkDefinition = Readonly<{
  definition: PreparationDefinition;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
}>;
```

The retained `definition` is immutable meaning only: its accepted filter, `id` or `ordinal` sort, and exact release
digest/body reconstructed from the retained canonical basis. It is not current Source authority. `readRetainedDefinition`
currently recovers that meaning on the same live, fenced client. `readWorkDefinition` must build the Source fields
from its own native reads; it cannot implement the producer by recursively calling Search's
`readMembersPreparationWorkDefinition`, which validates this producer result and currently fails closed.

For the required curated source, `NativeSourceIdentity` is the existing account identity with exactly these current
fields: `route`, `collectionId`, `accountId`, `incarnation`, `generation`, `ownerEpoch`, `receivingEpoch`,
`effectKey`, and `scope: 'curated'`. The source row is `members-preparation-source.sql`; `preparationSourceIdentity`
reconstructs this value from the exact locator and row and rejects it unless the persisted identity deep-equals it.
The retained episode's original/reserved incarnation and generation must still match the current Collection row.

`CollectionSourceObservation` must come from the same native row, with all existing fields:

```ts
{
  collectionId,
  route,
  incarnation,
  revision,
  authority: { kind: 'curated' },
  stamp: { partition, epoch, position },
  basis: { digest, identity: { digest }, query: null, profilePins, projection: null },
}
```

Here `partition` is `partitionOf(route)`, `epoch` and `position` are the row's current native values, `digest` and
`identity.digest` are the current source basis and identity digests, and `profilePins` contains the actual retained
release digest when present. The existing `IdentityScopeObservation` is a separate currentness value, not a new
field on `MembersPreparationWorkDefinition`: Search reads its actual `captureId` and `committedRevision` from
`canonical_source_scope`, verifies the identity digest against those values, and calls Semantic revalidation on the
same transaction.

The producer and validator must retain the same live `OperationalTransaction` and Core client, exact route/owner/
Collection/episode, work-step mode and owner partition. Preserve the reserved incarnation/generation, immutable
basis/filter/order/release, current capture/revision, owner fence, and Source/identity fences. Search validates the
result in `readMembersPreparationWorkDefinition`; `advancePreparation` compares the initial and final definition,
Scope observation and owner fence before returning. After the Source transaction releases, selected apply reads
current Source and Scope again and restarts if the retained state, observation or owner fence changed.

Do not reconstruct an Actor, copy a capability, reuse a closed client, cast Command to Operational, synthesize Source
identity, add a writer, or expand permissions. Accounts retirement/erasure gates and the permanent writer gates stay
in force.
