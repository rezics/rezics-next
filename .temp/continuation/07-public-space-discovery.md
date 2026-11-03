---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/community/space-discovery*.ts',
      'services/kernel/src/community/space-discovery*.sql',
      'services/kernel/src/community/README.md',
      'services/kernel/src/search/discovery*.ts',
      'services/kernel/src/search/default-discovery.ts',
      'services/kernel/src/search/README.md',
      'services/kernel/db/search/indices/discovery-second-scope-v1.json',
      'services/kernel/src/content/feed*.ts',
      'docs/feeds.md',
      'apps/web/src/search/discovery*.tsx',
      'apps/web/src/search/discovery.ts',
      'apps/web/src/search/README.md',
      'apps/web/src/stories/public-space-discovery.stories.tsx',
      'services/kernel/test/search/public-space-discovery.test.ts',
      'apps/web/tests/public-space-discovery.test.tsx',
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
          'bun run --cwd services/kernel check test/search/public-space-discovery.test.ts && bun apps/web/scripts/focused.ts --private-network -- bun test tests/public-space-discovery.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'A visitor finds an active anonymous-readable Space by current title/summary, selects the space kind, and opens its canonical address; a Space without a Realm remains discoverable.',
          'Protected/removed/unreadable Spaces cannot appear through bearer privileges, stale candidates or cursors; Realm association and address changes repeat current native checks and never substitute another container.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 450, 'files': 15 },
}
---

# Find public Spaces by their own identity

A visitor discovers a public Space as a Space and opens its canonical home, without confusing it with its optional Realm or a Subject discussed there.

Read [decisions](docs/research/content-second-scope-plan.md#adopted-decisions), [Community identity](services/kernel/src/community/README.md), [presentation](services/kernel/src/community/README.md#realm-presentation), [Search mixed kinds](services/kernel/src/search/README.md#mixed-kind-foundation), and [Home](docs/feeds.md). Update Community's owner source contract and Search/Web/feed consumer contracts in this change.

Add a space primary kind with bounded native source enumeration, committed metadata/lifecycle/address changes and current owner hydration. Eligibility is the active Space's independent anonymous read; bearer privilege, Realm membership or popularity cannot widen it. Use the current Space title/summary and canonical native destination. A Realm association is optional and independently disclosed. Do not use an owner's picture or another container's presentation as a fallback. Space-only homes qualify on their own authority. Preserve the Context pointer, current address claims, lifecycle/head and carried-Realm binding before/final.

Reuse registry metadata, mixed generation activation, successor mapping, retained Source admission and current Search/Home card consumers; no parallel discovery service or popularity algorithm. Compose other delivered kinds without requiring them. Catalogue-only predicates remain not applicable under NOT, Subject/Account behavior stays covered, and removed/private candidates expose no keys. Missing shared Search Source composition retains typed readiness while the native owner adapter is delivered against its documented seam.

Done includes actual Space kind choice, card and canonical navigation under existing platform gates. Add named native cases and one navigation case, fewer test lines than product. Stories: public Space with Realm, Space-only, and terminal no matches, anonymous phone/desktop with recorded native responses. Target 400–500 product lines.
