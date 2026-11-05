---
goal: search
manager: search
---

# Continue Universal Search rating order for Concept works

The current implementation connects Concept statements to the retained scheme-bound hierarchy and native matcher,
uses released catalogue kinds, and calculates current positive kind-count lower bounds through a bounded disjunctive
query. The mounted Concept reader still accepts `name` and `rating`, but Universal Search admission supports only
`id`, `name` and `relevance`; `public-filter-consumer.ts` also returns `dependency_unavailable` for rating plans.

Finish the visit's existing `name`/`rating` sort contract by integrating the installed Global `PublicRatingSource`,
rating epoch guards and two-phase scored/unscored keyset helper with retained mixed Search. Preserve one global stable
order across the admitted Concept population, current eligibility, exact query/cursor binding, history/back/forward
and return-to-work state. Do not coerce rating to name or create a separate scheduler, index writer, or semantic
matcher. Add focused tests for scored and unscored ordering, sparse/refill pages, cursor phase continuation, and rating
epoch changes. Run the controller's native and browser acceptance after integration; the controller deferred those
checks for this attempt.
