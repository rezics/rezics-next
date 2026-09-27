import { defineCases } from './types.ts';

// Keep the former page path as the frozen acceptance-inventory identity.
export const cases = defineCases('docs/testing/content-composition.md', [
  {
    id: 'COMP01',
    scenario: 'Repeated content targets in one structure',
    requiredResult: 'Occurrence identities survive reorder and export.',
  },
  {
    id: 'COMP02',
    scenario: 'Concurrent reparent creates potential cycle',
    requiredResult: 'One valid fenced transition or conflict.',
  },
  {
    id: 'COMP03',
    scenario: 'Large stage fails halfway',
    requiredResult:
      'At most 30 records per graph projection receipt; checkpoint only after commit; retry resumes without duplicate effects; cancellation retains the active generation.',
  },
  {
    id: 'COMP04',
    scenario: 'Change target/authority during staging',
    requiredResult: 'Activation revalidates and rejects stale basis.',
  },
  {
    id: 'COMP05',
    scenario: 'Rebalance a dense sibling order',
    requiredResult: 'Bounded local work and stable occurrence IDs.',
  },
  {
    id: 'COMP06',
    scenario: 'Remove occurrence with progress and source mapping',
    requiredResult: 'Tombstone/history remains resolvable.',
  },
  {
    id: 'COMP07',
    scenario: 'Move dataset holding retained revision',
    requiredResult: 'History resolver/payload pins survive movement.',
  },
  {
    id: 'COMP08',
    scenario: 'Export a multi-source fixed manifest',
    requiredResult: 'Completeness and exact positions are explicit; no fabricated global snapshot.',
  },
]);
