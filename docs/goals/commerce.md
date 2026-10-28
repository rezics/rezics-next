# Commerce and personal library

## Outcome

Readers can collect subjects, manage private progress and holdings, publish chosen Collections and buy access.
Sellers can offer products and inspect settlement without introducing a second product catalogue in the processor.

## Done when

- Offers, checkout, orders and entitlements work through ordinary APIs; fulfilment has one durable effect and
  changes order state and entitlement together at the owning boundary.
- Signed payment events are deduplicated. Replays and forgeries add no effects; refunds and disputes revoke access
  according to the commerce contract. Settlement and payout statements reconcile without hidden payment assumptions.
- Curated and built-in Collections share one capability for identity, visibility, ordering, notes, membership,
  follows, export and mounting. Removing a Zone mount does not delete its Collection.
- Owners manage exclusive library state, independent labels, holdings/copies and all supported progress modes,
  including rereads and noncontiguous completed units, without private facts entering public discovery.
- Definition-driven library profiles apply consistently to all compatible subject types.
- Filtering and owner-local plans work in the library and state Collections with next-read visibility of owner writes.
- Lifecycle cleanup, public count disclosure and explicit publication follow their product owners.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes commerce, entitlements, settlements, the common Collection capability, personal library, labels, follows,
progress and holdings. Points, user-saved personal dynamic queries and library legal holds are deferred under
[public scope](../scope.md). Public publication is explicit; external personal-library imports are not inferred from
mapping metadata. Web owns checkout and library pages.

## Ownership

Owns `services/kernel/{src,db,test}/commerce/**` and `services/kernel/{src,db,test}/library/**`.
[Commerce](../../services/kernel/src/commerce/README.md),
[library](../../services/kernel/src/library/README.md), [library and Collections](../library-and-collections.md),
[labels](../library-labels.md), [profile consumers](../library-profile-consumers.md),
[dynamic Collections](../dynamic-collections.md) and [deletion](../deletion.md) own behavior.
Semantic owns definitions, subject identity and shared filter semantics; accounts owns Access; search owns catalogue
plans. Keep personal facts in their owner partition.

## Dependencies

Requires semantic references, redirects and release-pinned profiles; ordinary Access and resource grants; durable
kernel work; and admitted catalogue/disclosure interfaces for mixed lists. Supplies mountable common Collections to
Zones, follow steps to community joins and APIs to web. Agree concrete exports before assigning consumers.

## Acceptance

Use [commerce outcomes](../../specs/commerce-outcomes.test.ts),
[library outcomes](../../specs/library-outcomes.test.ts),
[label outcomes](../../specs/library-labels-outcomes.test.ts),
[profile outcomes](../../specs/library-profiles-outcomes.test.ts), and native commerce/library tests.
Cover buyer, refunded buyer, owner, another viewer, anonymous and suspended personas. Payment tests use signed
fixtures without live processor calls. Exercise collection visibility, duplicate occurrences, CAS conflicts,
progress preservation, private exclusions and sparse filtered pages. Use the owning kernel check runner and
[verification](../development/verification.md) for budgets and promotion evidence.

## External conditions

Payment processing availability, supported production configuration and payout operations are external conditions.
Do not wait for private setup to prove signed-event and entitlement behavior in fixtures. Keep payment eligibility
and provider policy in the commerce owner contract rather than repeating them here.
