---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/src/community/routes.ts",
    "services/kernel/src/content/appeal-routes.ts",
    "services/kernel/src/content/board-page.ts",
    "services/kernel/src/content/reads.ts",
    "services/kernel/src/content/reports.ts",
    "services/kernel/src/content/routes.ts",
    "services/kernel/src/content/subject-threads-cards.ts",
    "services/kernel/src/http/problem-error.ts",
    "services/kernel/src/library/collection-bulk-capture.ts",
    "services/kernel/src/library/collection-bulk-operation.ts",
    "services/kernel/src/library/copy-list-context.ts",
    "services/kernel/src/library/library-export-routes.ts",
    "services/kernel/src/library/list-import-anilist-routes.ts",
    "services/kernel/src/library/list-import-anilist.ts",
    "services/kernel/src/library/list-import-bangumi-routes.ts",
    "services/kernel/src/library/list-import-bangumi.ts",
    "services/kernel/src/library/list-import-entry-metadata.ts",
    "services/kernel/src/library/list-import-mal-routes.ts",
    "services/kernel/src/library/list-import-mal.ts",
    "services/kernel/src/library/list-import-metadata-coordinator.ts",
    "services/kernel/src/library/list-import-vndb-routes.ts",
    "services/kernel/src/library/list-import-vndb.ts",
    "services/kernel/src/library/personal-routes.ts",
    "services/kernel/src/library/shelf-score.ts",
    "services/kernel/src/library/views.ts",
    "services/kernel/src/rating/classification-ballot-own-page.ts",
    "services/kernel/src/rating/own-votes-counted.ts",
    "services/kernel/src/rating/own-votes-counted.sql",
    "services/kernel/src/rating/own-votes.ts",
    "services/kernel/src/rating/register.ts",
    "services/kernel/src/rating/routes.ts",
    "services/kernel/src/rating/source-observation-read.ts",
    "services/kernel/src/rating/source-provider-observation.ts",
    "services/kernel/src/rating/source-statistics.ts",
    "services/kernel/src/search/discovery-query.ts",
    "services/kernel/src/search/generation-publication.ts",
    "services/kernel/src/search/generations.ts",
    "services/kernel/src/search/http/routes.ts",
    "services/kernel/src/search/release-search-native-stream.ts",
    "services/kernel/src/search/release-search-source.ts",
    "services/kernel/test/**",
    "packages/client/src/kernel/**",
    "packages/client/src/index.ts",
    "packages/client/tests/*board-page*.ts",
    "packages/client/tests/*reading-page*.ts",
    "packages/client/tests/*ban-review*.ts",
    "packages/client/tests/*counted-own*.ts",
    "packages/client/tests/*diary*.ts",
    "packages/client/tests/*reading-insights*.ts",
    "packages/client/tests/*library*.ts",
    "packages/client/tests/feed-response.test.ts",
    "packages/client/tests/watch-management.test.ts",
    "packages/client/tests/publication-preparation-client.test.ts",
    "contracts/openapi.json",
    "apps/web/src/threads/**",
    "apps/web/tests/*reading*.test.ts",
    "services/kernel/src/library/reading-insights*.ts",
    "services/kernel/src/semantic/http/subjects.ts",
    "services/kernel/src/content/author-contribution-actions-schema.ts",
    "services/kernel/src/content/README.md",
    "services/kernel/README.md"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "waiting": [],
  "after": [],
  "estimate": {
    "lines": 9000,
    "files": 100
  },
  "inseparable": true,
  "criticalPath": false
}
---

# Finish retained content publication and receivers

Continue from the current admitted source after the committed, targeted Kernel type repairs. Preserve those repairs and
the integrated Search source fixes. The remaining work is to correct the outstanding Kernel compiler diagnostics,
complete source-derived client and OpenAPI publication, verify the installed public declarations, and deliver the
retained client and Web receivers through those declarations. The previous attempt did not emit declarations or
OpenAPI, and the focused Kernel test could not start because an existing board pin-advice route reports a security
mismatch. Treat the mismatch as an owner handoff unless the route's admitted source contract is included; do not
weaken authorization or edit undeclared risk-area paths.

## Acceptance

Repair the remaining compiler errors without suppressions, fabricated aliases, manual generated edits, weakened
validation, or changes to schema, migration, construction, placement, and output-tree checks. Run the supported
complete-input publication command:

`bun run --cwd services/kernel typecheck --emit-client --emit-openapi`

Verify emitted declarations with installed consumer imports, including diary unavailable versus known-null date states,
optional assessment states, counted-own-vote reader types, selected-account ban review, and the new source inputs below.
Report the source head, generated declaration and OpenAPI heads/blobs, root exports and signatures, installed typing,
and transport/native/rendered results separately. Add only focused tests for missing user-visible behavior and run the
landing command and typecheck for each changed workspace. Native and rendered acceptance remain with their owners.

## Retained delivery

Complete the Board and current-thread reading journeys; reading, Home, Watch, preparation, selected-account bans,
settings, exact decisions, classifications, counted votes, archive assessment, reflection choices, and diary receivers.
Preserve currentness, revision, cursor, retry, cancellation, disclosure, and retirement behavior. Include available
mounted source inputs from the admitted head without inferring callable signatures from route URLs. Preserve the
contribution lifecycle route's actual installed Subject signature and the report inspection envelope's `reportId`-only
case admission; return cursors restore navigation only. Keep the provider review response's current `viewerActions`
composition and mounted Context authority.

Include the admitted contribution action, Board pin-advice and private no-store watch/page, Realm question management,
yearly completion goals, reading-insights profiles and progress discovery, follows `targetType`, library entry ordering
and title coverage, and exact copy kind/status facets with full per-copy context. Keep their closed unions, unavailable
and preparing states, credentials, revisions, coverage, and opaque cursors source-derived. Physical condition waits for
Definitions admission and existing Library integration. Do not create a second slowMode generator. The referenced
`content/publication-inputs.md` was not present on the admitted head; use the actual mounted owner sources and record
any exact input contract that is still unavailable rather than guessing.

Native Home reactions, conversation activity, Realm roster, moderation directory, reporter route, and personal Home
composition were transferred to briefs 421–426. Watch and author context remain with their existing owner, and the
five held continuations retain their receivers. Do not implement those slices here. Receive additive schemas when
committed; do not wait for downstream journeys or introduce a permanent publisher loop.
