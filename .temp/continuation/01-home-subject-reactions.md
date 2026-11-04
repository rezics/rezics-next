---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/content/feed-contract.ts',
      'services/kernel/src/content/feed-reactions.ts',
      'services/kernel/src/content/feed-subject-reactions.ts',
      'services/kernel/src/content/feed-subject-reactions.sql',
      'services/kernel/src/content/feed.ts',
      'services/kernel/src/content/reads.ts',
      'services/kernel/src/content/README.md',
      'services/kernel/test/content/feed-subject-reactions.test.ts',
      'services/kernel/test/content/feed-subject-reactions-growth.test.ts',
      'services/kernel/test/content/feed-contract.test.ts',
      'docs/feeds.md',
      'apps/web/src/features/feed/home-feed-reaction.ts',
      'apps/web/src/features/feed/home-feed-item.tsx',
      'apps/web/src/features/feed/action-bar.tsx',
      'apps/web/src/features/feed/README.md',
      'apps/web/tests/home-native-reactions.test.tsx',
      'apps/web/tests/home-subject-reactions.test.tsx',
      'apps/web/src/stories/home-subject-reactions.stories.tsx',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'command':
        [
          'bun',
          'run',
          '--cwd',
          'services/kernel',
          'check',
          'test/content/feed-subject-reactions.test.ts',
          'test/content/feed-subject-reactions-growth.test.ts',
        ],
      'placement': 'default',
      'tests':
        [
          'Home Subject cards disclose current native enjoyment counts, viewer selection and action advice in the bounded feed response and react through the existing Subject command engine.',
          'Anonymous, zero, unavailable, concealed, redirected, account-switch and uncertain-write states preserve native meaning, source retirement and exact retry without per-card hydration.',
          'Fixed selected targets and homes retain derived physical-work and byte bounds at independent 256/1024/4096 growth.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 2400, 'files': 18 },
}
---

# React to a currently readable Subject from Home

## Outcome and owners

A reader discovering or resuming a Subject on Home sees its currently disclosed enjoyment reactions and their own
selection, can choose an admitted reaction or clear it, and can recover an uncertain command without reopening
the Subject. Anonymous readers get the existing sign-in return. Unknown projection and known zero look different.
This completes only the Subject-card portion of audit A01.

Read [the adopted mapping](../../docs/research/content-gap-journeys-plan.md), [Home reaction summaries](../../docs/feeds.md#content-reaction-summaries),
[native reaction semantics](../../services/kernel/src/content/README.md#reactions) and
[the existing Feed action handoff](../../apps/web/src/features/feed/README.md#producer-and-board-handoff).
The installed feed reaction projector deliberately handles Content thread/post/review keys; its target type excludes
Subjects. The existing reaction writer already supports Subjects. Confirm those premises against the assigned base.

Decision: Subject Home controls use only like, love, laugh, insightful and sad. Native ratings, classification
assessments and provider figures remain their own meanings. No upvote/downvote or manufactured Subject score.

## One native page and existing interaction

Extend only feed-local Subject variants for selected discovery, following and continue rows. Keep Semantic's shared
public Subject summary and Search caches free of viewer state. Derive the exact native Subject command target from
current readable identity; retain the original/canonical observation through final disclosure. Redirects, concealment
and replacement may not attach one Subject's slot to another card. Preserve all thread/post/review fields.

The same `GET /v1/feedItems` response supplies admitted count state, count freshness, exact target, authenticated
viewer slot and current allowed-action advice. Reuse installed Subject count, slot, identity and Access authorities.
Advice explains available actions but never authorizes a write. Omit private fields for anonymous readers; successful
authenticated null means no selection. Withhold unavailable counts/slots explicitly instead of inventing zero/null.
Preserve native aggregate convergence and merge behavior, including an unknown source watermark.

Deduplicate selected Subject identities, batch by represented home and bound input by the existing 20 displayed /
160 raw candidate / one-round feed schedule. Do not read counts or viewer slots inside each card mapper, enumerate
partitions, scan merge history or refill refused rows. Release foreign preparation before owner checkouts. After
hydration recheck current Subject/readability and viewer/source witnesses; a dependency failure retains the affected
lane's exact retry frontier. Public caching must not include authenticated fields.

Connect the installed Home card and shared reaction engine to these emitted fields. Subject controls keep their
five-kind presentation; preserve existing Content vote controls, Library/Continue actions, destinations and keyboard
focus. No new request engine, per-card mount read or optimistic count authority. Use existing PUT/DELETE Subject
reaction commands and point reconciliation after a deliberate write. Account/credential/source/target changes retire
displayed selection and late feedback. Unknown commands retain the original immutable intent and exact retry.

The existing complete-input publisher owns generated KernelClient/OpenAPI output. Work against the documented native
contract or a narrow named seam while publication is pending; hand it the source changes. Consumer aliases ultimately
derive from emitted mounted types. No hand-edited generated declarations or parallel browser DTO. Coordinate shared
feed files with the activity continuation without making file overlap a dependency.

## Cost

Add operation-local Cost subsections to `docs/feeds.md`, linked from Content's owner, with exactly these bullets:

- **Touches:** derive every selected identity/readability preparation, count-home batch, viewer-home slot batch,
  action-advice authority, final confirmation, transaction control and retry. Include nested Access/Semantic work,
  all participating pools, retained native documents and materialized/serialized UTF-8 bytes.
- **Bound:** define selected unique Subjects S <= 20, represented homes H <= S, five native kinds and the existing
  raw/output ceilings. Derive physical-prefix and statement bounds from actual callees; charge alias/merge handling,
  anonymous/private branches, sparse output and repeated authority. Output size is not examined-row evidence.
- **Growth check:** hold S, H, limits and admitted bytes fixed while independently growing unrelated reactions,
  selected identity/merge history and account/authority history at 256/1024/4096. Capture actual plans, examined
  rows/blocks, SQL/control work, pool/runner phases and bytes, including empty, stale, denied and same-input retry.

## Done and focused acceptance

Write the missing outcome and growth tests named in front matter. Use command-created native Subjects/accounts,
real Access and registered reaction delivery. Pin selected and cleared slots, all five kinds, authentic known-zero
versus missing coverage, duplicate keys, merge/redirect, permission loss during fill, suspended/replaced caller,
anonymous omission and failure without cursor advance. Keep the existing thread/post reaction assertions. If an old
non-frozen test assumes all Semantic cards lack reactions, update only that assumption and list the changed test.

Add the focused Home interaction cases to `home-subject-reactions.test.tsx`; reuse `home-native-reactions.test.tsx`
for unchanged Content behavior. Verify selection, deliberate clear, sign-in return, unavailable controls, late response
retirement and unknown-write retry through the installed engine. Keep tests fewer lines than product code.

Add only three story states from recorded native responses: signed-in Subject with selected reaction and known counts;
signed-out Subject with sign-in action; unavailable Subject reaction projection with retry. Review each at 390 and
1280 pixels using the established Feed story provider. Use no invented response fixture to assert native delivery.
Report native, emitted-type and rendered outcomes separately. Follow the launcher's verification policy; deferred
native/browser/growth execution remains integration work and is not a reason to duplicate an owner or weaken checks.
