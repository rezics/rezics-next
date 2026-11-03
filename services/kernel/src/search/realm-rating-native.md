# Native Realm rating Search

`createRealmRatingNativeSource` in [realm-rating-native.ts](realm-rating-native.ts) is installed as
`realmRatings` in the production `createSearchService` caller in [server.ts](../server.ts).
It currently returns typed `index_not_ready` with Retry-After for observation and reads.
This binding does not establish native order execution.

## Readiness

The installed Content export is `createRealmRankSource` / `RealmRankSource.page` in
[realm-rank.ts](../rating/realm-rank.ts). It supplies a partition-local scored-only
`score_desc` page. Its request has no complete Subject predicate; its candidates have
no canonical name key, unscored complement or independently homed source observations.
Its existing API remains unchanged. Content's complete-order factory/types and
`35-realm-rank-complete-order.md` are absent from this source.

Search therefore retains explicit unavailability until Content delivers the complete
capability. A scored preview cannot supply this adapter, and absence of a preview
candidate cannot establish an unscored Subject. The selected rating Realm does not
impose membership, thread or Space scope. Global order is never a substitute.

The delivered capability must admit the complete Search text/catalogue/resource
predicate, canonical identity and name generation, question identity/revision/scale,
same-question/population prior eligibility interval, native figure publication and
independent home epochs/snapshots. Search must adapt to those observations rather
than assume that figure and Subject positions are equal. Publication or authority
changes, including dependencies discovered during hydration and empty pages, must
be checked before disclosure. Inactive-prior ABA needs an eligibility generation.
Private below-threshold values must never become order keys or readiness clues.

## Cost

Touches: the current readiness boundary performs no native statements, seeks,
hydration or candidate retention. These zero operations describe refusal only.

Bound: successful useful-page execution is not admitted. Once Content delivers its
capability, derive partition count P, finite windows W, raw window size B and native
producer terms S, E(B), H(B) from that capability before dispatch. The journey bound
is C_compile + P*W*(S+E(B)+H(B)) + C_final, with memory at most P*B tuples plus the
existing finite merge frontier. Use static sums and indexed LIMIT; no refill cap or
local preview filter establishes useful pages. Unresolved native terms go to
Performance before admission.

Growth check: native 1x/4x/16x complete-order execution remains **unmeasured**. It
requires the installed product path, fixed request/page limits, sparse rejection
and currentness invalidation, recording statements, examined/returned rows, seeks,
actions and retained candidates. Separate each bounded step from total resumable
preparation/catch-up. The refusal tests are not growth or native execution evidence.
