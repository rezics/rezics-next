---
{
  "goal": "content",
  "manager": "content",
  "kind": "implementation",
  "paths": [
    "services/kernel/src/content/feed-contract.ts",
    "services/kernel/src/content/feed.ts",
    "services/kernel/src/content/feed-conversation-activity.ts",
    "services/kernel/src/content/subject-threads.ts",
    "services/kernel/src/content/subject-threads-conversation-activity.ts",
    "services/kernel/src/content/model.ts",
    "services/kernel/src/content/schemas.ts",
    "services/kernel/src/content/README.md",
    "services/kernel/test/content/feed-conversation-activity.test.ts",
    "services/kernel/test/content/subject-threads-conversation-activity.test.ts",
    "services/kernel/test/content/conversation-card-growth.test.ts",
    "services/kernel/test/content/feed-contract.test.ts",
    "docs/feeds.md",
    "apps/web/src/features/feed/home-feed-item.tsx",
    "apps/web/src/features/feed/README.md",
    "apps/web/src/features/pages/subject-community.ts",
    "apps/web/src/features/pages/subject-community-view.tsx",
    "apps/web/src/threads/activity.ts",
    "apps/web/tests/home-conversation-activity.test.tsx",
    "apps/web/tests/subject-community-activity.test.tsx",
    "apps/web/src/stories/conversation-activity.stories.tsx"
  ],
  "riskAreas": ["authorization", "disclosure", "rights", "deletion", "account"],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "acceptance": {
    "command": ["bun", "run", "--cwd", "services/kernel", "check", "test/content/feed-conversation-activity.test.ts", "test/content/subject-threads-conversation-activity.test.ts", "test/content/conversation-card-growth.test.ts"],
    "placement": "default",
    "tests": [
      "Home and Subject discussion/review cards receive current admitted reply-count and real last-contribution meaning in their existing bounded page response and open the exact conversation.",
      "Exact zero, lower-bound and withheld activity remain distinct through source, membership, account and cursor replacement, with same-input retry after dependency failure.",
      "Consumer select/hydrate/confirm/final-disclosure composition retains derived physical-work and byte bounds at independent 256/1024/4096 growth."
    ],
    "failing": true
  },
  "estimate": {"lines": 2500, "files": 21}
}
---

# Compare current conversation activity before opening a Home or Subject card

## Outcome and boundary

A person scanning Home or a Subject's discussions/reviews can judge admitted conversation size and latest real
contribution, open the exact conversation and continue a sparse list. A current empty discussion shows zero replies;
unavailable activity does not look empty. This finishes A08's Home and Subject-list assembly, including the work
community row. Reuse the shared Subject region so Character/Person/Organization do not get separate implementations.

Read [the adopted mapping](../../docs/research/content-gap-journeys-plan.md),
[the installed activity batch](../../services/kernel/src/content/README.md#installed-conversation-activity-batch),
[Subject threads](../../services/kernel/src/content/README.md#subject-threads),
[Home positions and cost](../../docs/feeds.md#page-positions-and-cost) and
[the existing Feed action contract](../../apps/web/src/features/feed/README.md#card-actions).
`createConversationActivityBatch(pool)` already owns source publication, invalidation, repair and select/confirm.
Its producer explicitly did not change these page assemblers. Confirm missing native page fields on the assigned base.

Existing live publication assignments retain Board and current-thread assembly. The integrated Subject card owner
already owns citations, reactions and request retirement; preserve those fields and controls. Do not implement a
second activity aggregate, repair loop, Board page, thread reader, rating producer or generator.

Decision: render only the installed current public cohort, with exact/lower-bound count and original contribution
time. Protected or incomplete cohorts remain withheld; viewer access is still checked separately by the page owner.

## Bounded page composition and rendering

Use the already selected thread/review references from `GET /v1/feedItems` and the native Subject-thread list. Group
and deduplicate their exact native thread identities. Keep Home's 20-output/160-candidate/one-round ceiling and the
Subject overview's five-row preview/full list's twenty-row limit. Do not discover work through aggregate/history
scans, refill refused rows, call an HTTP endpoint per card or change native order/cursor selection.

Bind one selected activity witness before labels, author/media/citation/reactions and action hydration. After those
reads call the existing batch confirmation and reobserve the page's exact thread/place/Realm/source and current
viewer disclosure. Compare copied initial observations; never mutate a selected witness until it appears equal.
Release one home before acquiring another. Native cohort currentness does not itself prove current Access.

Project a closed page-owned activity state from the installed producer: current with exact/lower-bound reply count
and original last-contribution time, or withheld without count/time. Do not expose internal authorization evidence
as browser permission. Preserve applicable existing page action advice in the same response; commands reauthorize.
The opening establishes time but is not a reply. Editing an old post never updates contribution time. Last-reply
removal/restoration is reflected through the existing producer, not repaired during page reads.

Source/dependency failure follows the page's existing unavailable/preparing behavior and preserves the input cursor;
it does not become zero, end-of-list or a partially confirmed current count. Sparse pages still advance only their
authentic examined frontier after a successful read. Identity/Realm/membership/account changes during fill must
withhold or retry under current page semantics. Retain anonymous/public versus authenticated/private boundaries.

Pass these fields through existing Home and Subject card presentation. Use the shared activity/count formatting,
retain the reply destination and announce exact versus lower-bound meaning accessibly. Do not count loaded replies,
use creation/edit time as guessed last activity, or sum unrelated reaction kinds. Preserve review score/citation,
reaction selection, Library/Continue and contribution destinations. Account, credentials, selected Subject, source,
context and route replacement retire old figures and late continuations together with the existing page visit.

Hand source schemas to the existing complete-input publisher. Consume emitted native DTOs through the installed
client when available; name a minimal seam while pending. Do not edit generated declarations, infer a new browser
DTO or make publisher completion depend on downstream rendering. Coordinate shared feed files with the Subject
reaction continuation; the two missing outcomes have no code dependency on each other.

## Cost

Add page-operation Cost sections to Content's owner and `docs/feeds.md`, each with exactly these bullets:

- **Touches:** compose selected Home/Subject references, both activity snapshots, all page hydration and final
  source/place/Realm/viewer disclosure. Charge existing native batch helpers, Semantic, Accounts, Access, media,
  citation and reaction callees, every participating pool/control/runner phase, full-body reads and serialized bytes.
- **Bound:** derive from selected T <= 20 native thread keys, represented homes H <= T, fixed page budgets and the
  installed producer limits. Preserve physical-prefix bounds for initial/final observations. Include duplicate keys,
  known-zero/lower-bound/withheld, sparse, guest/private, dependency-failure and exact retry branches. Output length
  alone cannot bound authority/history work.
- **Growth check:** independently grow unrelated threads/posts, selected removed/contribution history, account/
  authority history and source repair backlog at 256/1024/4096 while T, H, page limits and admitted bytes stay fixed.
  Measure the complete consumer operation, including strict indexed plans, actual examined rows/blocks, SQL/control
  work, retained/materialized/serialized UTF-8 bytes and all owner phases. Keep producer repair measurements with
  its original owner; this journey measures how page consumers call it.

## Done and focused acceptance

Write the three native tests named in front matter against command-created discussions/reviews and registered
publication/removal/restoration delivery with real Access. Cover current zero, multiple replies, edit without a
new contribution, newest removal/restoration, capped/lower-bound source result, incomplete/protected cohort, duplicate
references and the five/twenty-row boundary. Assert Home/Subject parity without adding Board/thread scope.

Change source coverage, place, Realm membership and caller between selection and final disclosure. Assert no stale
count/time/action escapes, the exact input frontier is retryable on dependency failure, and successful sparse pages
retain native continuation. Keep unchanged review/reaction/disclosure assertions. Update only superseded non-frozen
tests that assumed all activity was absent, and list those changes. Tests remain fewer lines than product code.

Add focused Home and Subject card tests for exact zero, lower-bound display/accessibility, withheld state, native
destination, continuation retry and replacement retirement. Use the existing shared region and request lifetime.
Add only three recorded-response story states, each composed with Home and Subject cards: current zero; current
populated/lower-bound; withheld with retry. Review at 390 and 1280 pixels, preserving keyboard destinations and
long labels. Recorded stories are presentation input, not proof of native delivery.

Follow the launcher's current minimal verification policy. Report native, emitted-type and rendered outcomes
separately; broader native growth/browser execution remains integration work when deferred. A fixture failure
measures zero cases and must not justify a weaker bound or invented current source.
