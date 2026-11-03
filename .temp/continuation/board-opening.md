---
goal: content
manager: content
kind: claim
paths:
  - services/kernel/src/content/board-page.ts
  - services/kernel/src/content/reads.ts
  - services/kernel/src/content/README.md
  - services/kernel/src/content/conversation-activity*.ts
  - services/kernel/src/content/conversation-activity*.sql
  - services/kernel/src/content/schemas.ts
  - services/kernel/src/content/routes.ts
  - services/kernel/test/content/*board-page*.ts
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
  - packages/client/tests/board-page*.ts
  - contracts/openapi.json
  - apps/web/src/threads/**
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 5a2e66c9-3f0d-4168-a2ad-117772a89e39
  - 4c5203e7-f966-44a3-9179-0fa8665af3db
estimate:
  lines: 1000
  files: 15
inseparable: true
---

# Finish the native Board opening journey

## Remaining outcome

Connect the Board reader's `readConversationActivityBatch(threadIds, { actor, deadline })` seam to the current
cohort witness described by `81-current-conversation-activity-completion.md`. The retained source currently exports
only `readConversationActivitySources`, whose coverage is explicitly unproven. Keep activity source, cohort
coverage, lifecycle and repair with that producer. Build against its documented current-witness seam while the
producer is unavailable; do not count candidate episodes, use page length, add another counter or modify Home.
Board already copies selected count and source fields so in-place producer refreshes cannot overwrite its initial
observation; retain that hydration-race protection.

Prove what the installed reaction aggregate can witness for a complete target summary and how source retirement
invalidates it. Keep absent or stale summaries unavailable without a fallback reader, preserve per-target freshness
and return retryable `503 dependency_unavailable` if a selected witness changes during hydration.

Complete mounted Board coverage for anonymous public readers, protected members, nonparticipants, moderators,
banned/suspended/revoked callers and indistinguishable missing/concealed Boards. Cover pins, ordinary candidates,
overlaps, repeated identities and homes, review/discussion context, all sort continuations, sparse pages, changed
cohorts, credential switching, zero/unavailable counts and dependency recovery. Revoke selected Board, Realm,
thread, author and media witnesses during hydration; no stale context or actions may survive.

Derive response-byte, retained-memory, statement, control, pool and runner bounds from the final callees and Access
retries. Under controller integration policy, capture native 256/1024/4096 growth for populated, empty, withheld,
stale and retry paths, separately growing author/media and membership/ban history, with strict physical-plan refusal.
Replace provisional cost wording with the derivation.

Generate the mounted schema into OpenAPI and the installed client, exporting the Board response from the mounted
route declaration. Deliver the exact factory signature, response head and populated/withheld/failed/retry examples
to the existing Web Board reader. Bind the response through that reader without another loader, then complete
phone and desktop review. Use compiler-database-backed declaration emission through
`bun run --cwd services/kernel typecheck --emit-client`.

## Acceptance

The mounted response returns a current exact or lower-bound comments count only with a matching request cohort
witness. Exact zero stays distinct from unavailable. Changed witnesses return retryable
`503 dependency_unavailable`. Generated OpenAPI and installed client types match the mounted schema. Native
persona, revocation, continuation, source-retirement, growth and Web review acceptance runs under controller
integration policy. Worker validation remains workspace typechecks and the changed focused tests with each
workspace's landing command; broader acceptance is deferred.
