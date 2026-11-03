---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/search/discovery*',
      'services/kernel/src/search/discovery-registry.ts',
      'services/kernel/src/search/default-discovery.ts',
      'services/kernel/src/search/discovery-hydration.ts',
      'services/kernel/src/search/discovery-documents.ts',
      'services/kernel/src/search/account-discovery.ts',
      'services/kernel/test/search/review-discovery*',
      'services/kernel/src/content/review-discovery.ts',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    [
      'Search registers the Content review source in its closed kind union and generation writer using the existing review thread ID.',
      'Bootstrap and incremental refresh consume exact source positions and sparse page continuation; current ineligible source reads write native deletions.',
      'Final hits hydrate current safe title and excerpt through Content and current author presentation through Accounts; protected reviews, stale hits, takedown and erasure are covered.',
      'The Search kind count uses unavailable evidence, and Realm discussion-popularity counts remain unchanged.',
    ],
  'estimate': 'one implementation increment',
}
---

Complete Search's consumer for the Content-owned `ReviewDiscoverySource` from `content/README.md`. The current Search
closed union contains only Semantic and Accounts owners, so this increment deliberately leaves generation storage,
query integration, and change-event routing with Search. Reuse Search's existing generation/index writer and native
query path; do not create a second review text index. Consume Content create/revision/restore/erasure/moderation
events and current gate-owner invalidations, with final Content and Accounts reads authoritative.
