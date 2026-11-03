# Discovery union owner contract

The registry keeps catalogue kinds release-driven and the existing `subject` and `account` response variants
unchanged. Second-scope metadata kinds use fixed owner slots: Commerce owns `collection`; Content owns `review` and
`space`. Each slot is explicitly `unavailable` or carries a ready owner adapter. A kind is not admitted by metadata
registration alone, and an absent port is never represented by a ready adapter that returns an empty population.

Canonical keys retain `{owner, kind, route, id}`. The UUID is validated against its route, and both owner and kind stay
in the key so a Collection, Review, Space, Subject, or Account with the same UUID remains distinct. A Review uses its
thread UUID with kind `review`. A Realm-backed Space contributes one result keyed by its native Space UUID with kind
`space`; the Realm is not a second result.

An admitted owner adapter reads current eligibility and returns only the closed public metadata envelope `{id, title,
summary}`. The shared hydration assembly matches each summary to its requested canonical ID and drops absent results.
Commerce and Content adapter outcomes own source eligibility, disclosure, and producer validation; this module does
not create their populations. Until those adapters are supplied, the three registry slots remain unavailable and
cannot create successful discovery.

These kinds initially support only `text` and `kind` conditions. Subject-only predicates are inapplicable, including
under `NOT`. The shared condition grammar and universal admission rules remain in the
[public filter consumer contract](public-filter-consumer-contract.md).
