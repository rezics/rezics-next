---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "services/kernel/src/content/feed*.ts",
    "services/kernel/src/content/feed*.sql",
    "services/kernel/src/content/reads.ts",
    "services/kernel/src/content/model.ts",
    "services/kernel/src/content/schemas.ts",
    "services/kernel/src/content/README.md",
    "services/kernel/test/content/*feed*.ts",
    "services/kernel/test/content/support/*feed*.ts",
    "docs/feeds.md",
    "packages/client/src/kernel/**",
    "contracts/openapi.json",
    "packages/client/src/index.ts",
    "packages/client/tests/feed-response.test.ts",
    "services/kernel/src/content/subject-threads*.ts",
    "services/kernel/test/content/*subject-thread*.ts",
    "apps/web/**"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "criticalPath": false,
  "waiting": [],
  "after": [
    "a99aa260-84bc-4a92-894d-dec4d184ca99",
    "61c22655-8419-4792-864c-0aa89aadc8f7",
    "f0faf5f4-b4f6-48df-857b-5f6dcb788b2a"
  ],
  "estimate": {
    "lines": 2200,
    "files": 18
  },
  "inseparable": true
}
---

# Complete the original Home review-target and reply-parent journey

Finish the remaining outcome within the same Content owner. The current code now exposes the reusable
`prepareFeedContentContext` composition from the selected Home and Subject-thread native paths, with closed schemas,
exact recorded citation values, current Subject and question summaries, public author identity and a bounded immediate
parent. Keep the existing Home card and shared FeedActionBar as the only Web interface owner. This continuation is
for the unfinished original journey, not a measurement-only successor or a second feed.

## Remaining native outcomes

Extend the production Kernel/native tests using real Access, registered effects, native command-created Subjects,
questions, review/thread openings and replies. Cover a permitted public nonstandard question plus private and withdrawn
questions; distinguish absent, concealed and failed citation states. Cover parent hide/removal, author erasure, Board
and Realm access revocation, target rebinding and question withdrawal between selection and final hydration. Verify
safe output with no hidden body, stale label, private citation or protected identity, and preserve exact current thread,
post and parent destinations, source revision/anchor, author, language and spoiler shape. Include duplicate parent and
author keys, mismatched native keys, stale anchors, empty and sparse pages, duplicate activities, maximum raw/output
limits, operational dependency failure with exact same-cursor retry, and account switch. Preserve reaction counts,
freshness, set/clear state and the viewer's own current selection through the complete response.

Use mounted production resource readers for action advice where the installed capabilities support it. Exercise guest
sign-in, denied and unavailable advice separately from successful reply/report/revise actions. A readable card by itself
must not grant an action, and commands continue to reauthorize. Do not add a role table or another reaction producer.
Preserve non-Content Home variants and current Search, Library and Collection ownership.

## Cost and growth

Review the context cost terms with Performance and complete the source-observation account for every nested Content,
Semantic, Accounts, Access, citation, mounted-action and reaction read, including each participating home, physical rows,
statements, full-body and serialization bytes, transaction/pool/runner phase and retry. Keep the raw selection limits and
all native ancestry work explicit. Add native growth at 256, 1024 and 4096 while holding raw/output limits, represented
homes, selected context keys and admitted payload bytes fixed. Independently grow unrelated feed, Subject and author
rows, selected thread ancestry/revision history and authority/grant history. Assert strict route/identity and cursor
prefix plans and record empty, denied, stale and retry branches. Preserve native seeding, strict withholding and plan
assertions; a fixture or approved-host failure is not reached evidence.

## Consumer and delivery acceptance

Publish the exact mounted method, factory signatures, schema and generated DTO aliases, selected-reference and
immediate-parent limits, all nested costs and source observations to the existing Web Home owner. Use generated
OpenAPI/client output from the Kernel generator; reconcile derived inputs with `defaults.json` and never fork a Web DTO.
Identify the exact Home card and shared FeedActionBar consumers. With that owner, review populated review and reply
cards, a concealed/removed parent, signed-out action state, retry, spoiler/language treatment and account switch. Cards
must show the current permitted work label and exact work/review/thread destination, exact recorded question/revision/
score, and the immediate parent with its current disclosed author and exact anchor. Verify request retirement on source,
target and account changes. Until the existing Web owner consumes and renders the response, retain an explicit
experience acceptance gap.

Run the admitted native outcome and three-scale suites and the appropriate shared typechecks through the controller.
Retain the current native fixed-size outcome test as the small regression case. Do not weaken a frozen acceptance.
