import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/search.md', [
  {
    id: 'SEARCH01',
    scenario: 'Join Realm-effective statements/rating, Main Version Chinese body and text query',
    requiredResult: 'One admitted ARQ/jena-text request yields correct binding and ranking scope.',
  },
  {
    id: 'SEARCH02',
    scenario: 'First search candidates all fail graph condition',
    requiredResult:
      "Prove the result within the profile's fixed call/work budget, or return the declared budget/asynchronous outcome. No open-ended refill, false empty answer or false complete Top-K.",
  },
  {
    id: 'SEARCH03',
    scenario: 'Public title and private body contain different terms',
    requiredResult: 'Private text cannot affect hits/snippets/facets.',
  },
  {
    id: 'SEARCH04',
    scenario:
      'Join two valid standing-rating paths to one text MatchUnit and one path to another eligible unit',
    requiredResult:
      'Exactly one result per effective Main Version, unchanged per-unit text score and total, exact current-slot rating sum/count, and no collapse of the second unit. Denied classification and stale continuation remain excluded/restarted; raw candidate overflow is a typed budget outcome.',
  },
  {
    id: 'SEARCH05',
    scenario: 'Run policy search on unsupported multi-dataset/source path',
    requiredResult: 'Explicit unsupported/unavailable, not successful empty result.',
  },
  {
    id: 'SEARCH06',
    scenario:
      'Index/query Chinese, Japanese, Korean and mixed identifiers through public Main and Realm phrase lanes',
    requiredResult:
      'The same versioned analyzer returns relevant matches bound to the exact selected Contribution revision and MatchUnit. Language filters exclude matching text in other tagged variants; source bodies and language tags remain exact.',
  },
  {
    id: 'SEARCH07',
    scenario: 'Change joined author/classification/selection',
    requiredResult: 'Bounded affected-root refresh, not full-corpus sync.',
  },
  {
    id: 'SEARCH08',
    scenario: 'Switch analyzer/backend generation during paging',
    requiredResult: 'Snapshot-bound cursor or explicit restart; rollback respects erasure.',
  },
  {
    id: 'SEARCH09',
    scenario: 'Ask historical search on current-only index',
    requiredResult: 'Unsupported result, not mislabeled historical data.',
  },
  {
    id: 'SEARCH10',
    scenario: 'Exhaust candidate/memory/time budget',
    requiredResult: 'Typed partial/budget outcome; count/facet precision independently stated.',
  },
  {
    id: 'SEARCH11',
    scenario: 'A visible searched property coexists with a hidden matching property',
    requiredResult:
      'Any-visible-property admission cannot reveal the hidden match, score, snippet or count.',
  },
  {
    id: 'SEARCH12',
    scenario: 'Access/content epochs advance on opposite sides of query admission',
    requiredResult: 'The declared lease/fence behavior holds; no unqualified post-filter fallback.',
  },
  {
    id: 'SEARCH13',
    scenario: 'Delete the last indexed triple in a named graph',
    requiredResult:
      'Keep a nonindexed sentinel in that graph and verify it exists, then query text without an RDF join; a vanished graph must not mask a stale index entry.',
  },
  {
    id: 'SEARCH14',
    scenario: 'One subject has title/body predicates with terms split across fields',
    requiredResult:
      'Per-triple behavior is explicit; cross-field conjunction uses joined bindings with declared score aggregation.',
  },
  {
    id: 'SEARCH15',
    scenario:
      'Change one graph literal after pinning an index reader, or crash between store/index operations',
    requiredResult:
      'No false complete fenced result; suspend/rebuild or use a qualified paired reader.',
  },
  {
    id: 'SEARCH16',
    scenario: 'Page after a graph/index change or authority narrowing',
    requiredResult:
      'Materialized handle with current disclosure or explicit restart; HTTP requests do not share a TDB2 snapshot.',
  },
  {
    id: 'SEARCH17',
    scenario: 'Import RDF directly while bypassing the text wrapper',
    requiredResult:
      'Search stays unavailable until offline rebuild and membership/frontier checks complete.',
  },
  {
    id: 'SEARCH18',
    scenario:
      'Increase corpus size, degree, rejected candidates, languages and payload sizes; run with cold caches, stale readiness, retries and cursor creation',
    requiredResult:
      "End-to-end traces stay within the profile's numeric total-call, serial-stage, byte, fanout and retry caps, including Account/Access and nested adapters. Over-cap input is rejected/routed explicitly; no per-hit calls or automatic refill. Core admitted queries retain correctness and meet the elected mixed-load latency/error objectives rather than passing by rejection.",
  },
  {
    id: 'SEARCH19',
    scenario:
      "PostgreSQL body revision commits before graph adoption/index visibility; duplicate and reorder both owners' events",
    requiredResult:
      'Only exact eligible adopted revisions contribute. Stale workers cannot replace newer text; missing units yield declared pending/unavailable, never false complete empty. Public/private and same-language variants remain distinct; sparse Realms do not multiply body copies.',
  },
  {
    id: 'SEARCH20',
    scenario:
      'Lose the RDF body projection and Lucene index, then restore with a changed Content cut and erasure frontier',
    requiredResult:
      'Regenerate approved MatchUnits from exact PostgreSQL revisions plus graph references, then rebuild Lucene. Missing bodies keep affected search unavailable; erased or draft text cannot reappear. Indexer success alone does not prove source completeness.',
  },
]);
