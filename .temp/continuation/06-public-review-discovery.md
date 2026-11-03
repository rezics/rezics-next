---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/content/review-discovery*.ts',
      'services/kernel/src/content/review-discovery*.sql',
      'services/kernel/src/content/register.ts',
      'services/kernel/src/content/README.md',
      'services/kernel/src/search/discovery*.ts',
      'services/kernel/src/search/default-discovery.ts',
      'services/kernel/src/search/README.md',
      'services/kernel/db/search/indices/discovery-second-scope-v1.json',
      'services/kernel/src/content/feed*.ts',
      'docs/feeds.md',
      'apps/web/src/search/discovery*.tsx',
      'apps/web/src/search/discovery.ts',
      'apps/web/src/search/README.md',
      'apps/web/src/stories/public-review-discovery.stories.tsx',
      'services/kernel/test/search/public-review-discovery.test.ts',
      'apps/web/tests/public-review-discovery.test.tsx',
    ],
  'riskAreas': ['authorization', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'command':
        [
          'sh',
          '-c',
          'bun run --cwd services/kernel check test/search/public-review-discovery.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/public-review-discovery.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A visitor finds one review result per live review thread, sees current subject/author context and opens its canonical thread from Search/Home; ordinary discussions do not become reviews.',
          'Protected containers, hidden subject, deleted/withheld opening or erased author output cannot leak an ID/excerpt through a stale candidate or cursor; stored vote citations never become current rating figures.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 450, 'files': 16 },
}
---

# Find public reviews as readable review results

A visitor discovers a public review by its own current title/excerpt and opens the existing review thread with clear reviewed-subject context.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [reviews](services/kernel/src/content/README.md#reviews), [native review witnesses](services/kernel/src/content/README.md#review-backed-question-witnesses), [mixed discovery](services/kernel/src/search/README.md#mixed-kind-foundation), and [Home](docs/feeds.md). Update Content's source/disclosure contract, Search/Web kind contract and feed contract in the same change.

Introduce review as the primary kind, keyed by native thread, with bounded indexed owner source pages and current hydration. It is never an editorial Subject or a duplicate generic thread hit. Anonymous current subject, opening revision, board, Realm and Space reads must independently pass before/final. Use the existing native immutable revision and bounded plain-text excerpt projection; index no copied document body or private vote. No numeric card rating is required; an optional historical citation is explicitly historical. Project committed creation/revision/publication/withdrawal changes idempotently, including concealment after takedown or erasure.

Extend existing registry, kind metadata, successor mixed mapping, current hydrator and canonical thread destination, composing other delivered kinds without depending on them. Preserve Subject/Account wire and predicates; catalogue-only leaves remain not applicable under NOT. Keep native generation activation, retained Source admission, sparse opaque cursors and platform gates. If the shared Search Source is pending, expose the native owner seam with typed readiness rather than certifying a page as a population.

Done includes the actual Review kind choice/card in Search and Home. Preserve existing review authoring/citation assertions. Add named native cases and one navigation case; fewer test lines than product. Stories: public review and terminal no matches, anonymous phone/desktop with recorded native responses. Target 400–500 product lines.
