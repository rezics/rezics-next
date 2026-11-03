---
{
  "goal": "content", "manager": "content", "kind": "implementation",
  "paths": [
    "services/kernel/src/rating/realm-ranking*.ts",
    "services/kernel/src/rating/realm-ranking*.sql",
    "services/kernel/src/rating/routes.ts",
    "services/kernel/src/rating/README.md",
    "services/kernel/db/rating/migrations/*_realm_ranking.sql",
    "services/kernel/db/rating/schema.sql",
    "services/kernel/src/rating/aggregate-effect.ts",
    "services/kernel/src/search/README.md",
    "docs/goals/content.md",
    "docs/goals/content.capabilities.md",
    "apps/web/src/community/realm-rating*.tsx",
    "apps/web/src/community/space-page.tsx",
    "apps/web/tests/realm-rating-order.test.tsx",
    "apps/web/src/stories/realm-rating-order.stories.tsx",
    "services/kernel/test/rating/realm-ranking-http.test.ts"
  ],
  "riskAreas": ["authorization", "disclosure"],
  "criticalPath": false, "after": [], "waiting": [],
  "acceptance": {"command": ["sh", "-c", "bun run --cwd services/kernel check test/rating/realm-ranking-http.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/realm-rating-order.test.tsx"], "placement": "default", "tests": ["A reader pages through same-population Bayesian order and labelled figures; a valid zero remains scored, below-threshold data does not reveal a score, and ties use subject ID.", "A protected Realm nonmember or newly banned reader receives no figures or ordering; prior, membership or publication changes invalidate an old continuation; Global figures remain unchanged."], "failing": true},
  "estimate": {"lines": 500, "files": 15}
}
---

# Show a Realm’s own Top rated subjects

A reader opens Top rated on a Realm home and sees that Realm's standard-question population, with Global separately labelled where already supported. Deliver a bounded native ranking endpoint and its small Realm-home panel, plus a typed population-order source for Search. This is the first usable Realm sort; Search retains generalized Realm predicate planning.

Read [adopted decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Rating](services/kernel/src/rating/README.md#aggregates), [Search order](services/kernel/src/search/README.md#global-rating-order) and [Community](services/kernel/src/community/README.md). Update Rating's owner contract and Search's consuming seam in this change; align the stale Realm-sort deferral in docs/goals/content.md and content.capabilities.md.

Done means at most 20 subjects per page from an indexed Realm/question frontier, updated idempotently from native aggregate/population work. Use the same-population Bayesian prior and existing score/privacy thresholds; distinguish updating/unavailable from known unscored. Bind cursor to Realm, question, prior/publication version and viewer; recheck Realm, host Space and subject authority before output. A native population version fences asynchronous membership changes. No private Realm score or order enters the public index, no Global substitution, and no fetched-prefix reranking. The endpoint must declare freshness and physical read/write bounds.

Implement against Search's documented source interface if its generalized planner is pending; do not rebuild that planner. Keep existing Global tests. Add the two native acceptance cases and one panel interaction case, fewer test lines than product lines. Stories: Realm-home panel, member ready and below threshold, plus protected nonmember closed, at phone and desktop using recorded native responses. Target 400–500 product lines; update owner docs in the same commit.
