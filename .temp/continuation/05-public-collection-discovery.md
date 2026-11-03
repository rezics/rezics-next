---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/library/collection-discovery*.ts',
      'services/kernel/src/library/collection-discovery*.sql',
      'services/kernel/src/library/README.md',
      'docs/library-and-collections.md',
      'services/kernel/src/search/discovery*.ts',
      'services/kernel/src/search/default-discovery.ts',
      'services/kernel/src/search/README.md',
      'services/kernel/db/search/indices/discovery-second-scope-v1.json',
      'services/kernel/src/content/feed*.ts',
      'docs/feeds.md',
      'apps/web/src/search/discovery*.tsx',
      'apps/web/src/search/discovery.ts',
      'apps/web/src/search/README.md',
      'apps/web/src/stories/public-collection-discovery.stories.tsx',
      'services/kernel/test/search/public-collection-discovery.test.ts',
      'apps/web/tests/public-collection-discovery.test.tsx',
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
          'bun run --cwd services/kernel check test/search/public-collection-discovery.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/public-collection-discovery.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A visitor finds a listed public Collection by its own metadata, selects its collection kind and opens the canonical Collection page from Search or Home.',
          'Private/unlisted/withdrawn/pending-only output is absent; pending B does not replace selected public A; current visibility reduction and terminal curator policy govern continuation without leaking rules or personal facts.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 500, 'files': 16 },
}
---

# Find public Collections through Search and Home

A visitor finds public Collections as Collections in the existing Search/Home discovery and opens the existing canonical page. Contained Books never turn a Collection into a Book result.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Collection disclosure](docs/library-and-collections.md#indexed-filtering-and-disclosure), [Library output](services/kernel/src/library/README.md#explicit-membership-publication-hooks), [Search mixed kinds](services/kernel/src/search/README.md#mixed-kind-foundation), and [Home](docs/feeds.md). Adopt source/eligibility in Library's README and kind/consumer changes in Search/Web and feed owner docs.

Add the collection owner discriminator, bounded native source/page/current hydrator, committed update/withdrawal integration, registry metadata and summary/destination. Only explicitly public/listed metadata with selected COMPLETE public output qualifies. Keep selected A while B builds; unlisted known-ID read is never discovery eligibility. Honor native curator-erasure/public-output rules. No rule AST, private facts, contained-subject text expansion or unchecked totals. Apply anonymous native authority before/final, regardless of bearer privileges. Catalogue-only predicates remain not applicable even under NOT.

Reuse the existing complete mixed-generation activation and retained Source contract; add a successor mapping, never edit an active immutable mapping. Compose other delivered second-scope kinds without requiring their code. If the shared Search Source producer remains pending, build the native owner adapter against its documented seam and retain typed readiness; do not fake complete population evidence. Preserve existing Subject/Account behavior and signed sparse continuations.

Done includes actual kind choice and Collection card/navigation in Search and Home under existing gates. Add named native cases and one card journey; fewer test lines than product. Stories: public card and terminal no matches, anonymous phone/desktop using recorded native responses. Target 450–500 product lines.
