import { createHash } from 'node:crypto';
import type { Case } from './acceptance.ts';

// Reviewed on 2026-10-01 to include SAFETY01–08 and CLP01–07 as backend obligations, and on 2026-10-04 when CLP01–07
// moved from their task brief to the editorial-protection owner page with the same IDs and scenarios.
// Adding, removing, renaming or moving an acceptance row
// requires an explicit backend-scope review before the Goal denominator changes.
export const inventoryFingerprint = '627efc1346544f28f8c4f349da2076406b1aded9c3a45c54acb73218ce5a69ab';

export const excludedFrontendCases = {
  VIEW04: 'Historical Block rendering and executable-markup isolation are rendered-client behavior; the backend still preserves unknown Block data under its model and export contracts.',
} as const;

export function selectBackendCases(inventory: readonly Case[]): {
  cases: Case[]; excluded: { id: string; page: string; reason: string }[];
  inventoryFingerprint: string;
} {
  const sorted = [...inventory].sort((a, b) => a.id.localeCompare(b.id));
  const actual = createHash('sha256').update(sorted.map(item => `${item.id}\t${item.page}`).join('\n'))
    .digest('hex');
  if (actual !== inventoryFingerprint) {
    throw new Error(`Acceptance inventory changed (${actual}); review the backend scope before running it`);
  }
  const exclusions = new Map(Object.entries(excludedFrontendCases));
  const excluded = sorted.filter(item => exclusions.has(item.id)).map(item => ({
    ...item, reason: exclusions.get(item.id)!,
  }));
  if (excluded.length !== exclusions.size || excluded.some(item => item.page !== 'docs/testing/presentation-and-addressing.md')) {
    throw new Error('Backend scope exclusion no longer matches its owning case');
  }
  return { cases: sorted.filter(item => !exclusions.has(item.id)), excluded,
    inventoryFingerprint };
}
