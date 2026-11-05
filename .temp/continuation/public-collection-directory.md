# Public Collection directory continuation

- Goal: `search`
- Manager: `search`

## Delivered in this attempt

Search now admits a typed Collection directory selection (`presentationKind`, canonical curator and Subject IDs,
and `recent` or `popular` order), includes it in native cursor binding, and only dispatches it when the Collection
owner advertises the `collectionDirectory` capability. The mounted `/collections` page carries the complete
selection through its address, query key, request, continuation/restart links and filter form. Without the native
capability it reports preparation and does not return unfiltered or stale index candidates.

## Remaining work

Commerce58 has not delivered the native Collection directory operands in this base. Extend the existing Commerce
Collection discovery producer and receiving adapter contract with explicit presentation kind (including unset
`mixed`), curator identity/display context, current disclosed curated or selected last-complete public dynamic
membership, native popularity/follow count, and exact nullable public update time. Keep native collection source
reads partition-local and at most 100 keys; preserve missing values. Carry those fields through explicit adapter
copies and the one projection codec.

Implement the admitted indexed directory query over owner field/member seeks, with native recent/popular order,
stable full-identity ties, selection-bound cursors and query-wide native currentness. Hydrate current disclosure and
the selected predicate/order observations through the existing batch reader/context; account for newly eligible
candidates outside the earlier page. Bound skipped candidates, selected-output checks, partition batches,
disclosure and final validation using actual Search/Commerce limits. Do not add a parallel listing authority or
per-result full Collection reads.

Then add focused native/browser coverage and run the retained seeded current-dev journey: explicit kinds and mixed,
two curators, overlapping Subjects, order ties, more than one page, canonical open/return, each filter and sort,
and publication-driven membership/privacy currentness. Render the directory at 390/1440 in light/dark and capture
controller evidence. Acceptance, native and browser verification are deferred to integration per the task contract.
