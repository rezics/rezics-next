# Native Realm rating Search

`createRealmRatingNativeSource` in [realm-rating-native.ts](realm-rating-native.ts) is installed as
`realmRatings` in the production `createSearchService` caller in [server.ts](../server.ts).
Observation and both reads return typed `index_not_ready` with Retry-After until complete
native order is available, including for authenticated readers and empty predicates.

## Readiness

Content exports `createRealmRankOrderSource` / `RealmRankOrderSource` in
[realm-rank.ts](../rating/realm-rank.ts). Its `readScoredPartition` seeks
`score DESC, subject_id DESC`, its candidates have no canonical name, and its input
has no complete Subject predicate capability. `proveFigures` supplies exact native
figure eligibility probes, not a canonical unscored seek. These exports do not yet
supply the complete order required here. The older scored-only `createRealmRankSource`
and its API remain unchanged. The named `35-realm-rank-complete-order.md` is absent.

Decision: retain typed unavailability for the selected Realm until Content supplies
complete canonical predicate/order execution; never adapt the partial score/UUID seek.

The replacement binding must consume the complete admitted Search text/catalogue/resource
predicate once, with canonical identity/name generation, question identity/revision/scale,
same-question/population prior eligibility interval, figure publication and independent
home epochs/snapshots. A figure position is not a canonical Subject position merely
because both are numbers. Private below-threshold figures cannot affect order or readiness.
The complete Subject domain is independent of Realm membership, threads and Spaces.

Search's complete-order consumer merges scored tuples as `score DESC, name_sort ASC`
(missing names last), then canonical ID ascending. Unscored tuples use `name_sort ASC`
(missing last), then canonical ID ascending. Zero is a scored value. Figure and canonical
Subject snapshots retain independent home positions; the consumer validates each source's
snapshot without equating those positions.

Final native validation must include dependencies discovered during hydration and empty
pages. Changes to names, identity, prior, question, source or current Realm/Subject authority
must restart or refuse before disclosure. Inactive-prior ABA requires an eligibility
interval. Missing native evidence cannot establish an unscored Subject or empty success.

## Cost

Touches: the Search consumer performs finite partition merges and bounded candidate
checks. The installed native readiness boundary still issues no native statements, seeks,
hydration or candidate retention; those zero operations describe refusal only.

Bound: successful useful-page execution remains unadmitted. Derive partition count P,
finite windows W, raw window size B and producer terms S, E(B), H(B) from the complete
capability before dispatch. The bound is C_compile + P*W*(S+E(B)+H(B)) + C_final,
with memory at most P*B tuples plus the finite merge frontier. Use static sums and indexed
LIMIT. A scored preview, local filtering or fitted refill cap does not establish W.
Unresolved native terms require Performance review before admission.

Growth check: actual installed-path 1x/4x/16x complete-order execution remains **unmeasured**.
The continuation must exercise the installed service with fixed request/page limits,
sparse rejection and currentness invalidation, recording native statements,
examined/returned rows, seeks, actions and retained candidates. Separate per-step
work from total resumable preparation/catch-up. Refusal and injected-source tests do not
prove installed native order.
