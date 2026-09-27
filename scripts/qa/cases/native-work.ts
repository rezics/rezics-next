import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/native-work.md', [
  {
    id: 'WORK01',
    scenario: 'Create metadata-only Work',
    requiredResult: 'Main Version entry exists without dummy body/release.',
  },
  {
    id: 'WORK02',
    scenario:
      'Add two same-language native variants, and separately published official/third-party translated Works',
    requiredResult:
      'Native variants retain one version spine; separate publications retain Work/version identities and translation links. Record version-scoped provenance without recursive body copies. Personal choice works without a Realm override.',
  },
  {
    id: 'WORK03',
    scenario: 'Switch adopted content in one Realm',
    requiredResult: 'Other selections and contributor control unchanged.',
  },
  {
    id: 'WORK04',
    scenario: 'Create adaptation/recording/software fork',
    requiredResult: 'Continuity decision preserves explicit derivation.',
  },
  {
    id: 'WORK05',
    scenario: 'Seal release then correct metadata',
    requiredResult: 'Pinned content stays exact.',
  },
  {
    id: 'WORK06',
    scenario: 'Rate Main Version and exact release',
    requiredResult: 'Targets/populations are not silently pooled.',
  },
  {
    id: 'WORK07',
    scenario: 'Use package Main Version as install request',
    requiredResult: 'Resolve to concrete eligible release/artifact before lock.',
  },
  {
    id: 'WORK08',
    scenario: 'Import equal provider names/IDs at different grains',
    requiredResult: 'No automatic identity merge or fabricated parents.',
  },
  {
    id: 'WORK09',
    scenario: 'Save competing PostgreSQL Content edits and retry after a lost response',
    requiredResult:
      'One expected-head winner; revision/retained bytes/receipt/outbox agree in one SQL transaction. Draft saves do not require a graph mutation. Exact history and byte digests remain stable through both owner adapters.',
  },
  {
    id: 'WORK10',
    scenario:
      'Prepare Content, activate graph publication, then interrupt outcome delivery or run GC',
    requiredResult:
      'An exact pinned revision survives ambiguous publication; duplicate reconciliation is idempotent. Rejected publication preserves the saved revision; pins release only after terminal proof. Erasure fences stale activation.',
  },
]);
