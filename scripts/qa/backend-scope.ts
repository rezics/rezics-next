import { createHash } from 'node:crypto';
import type { Case } from './acceptance.ts';

// Frozen on 2026-09-26. Adding, removing, renaming or moving an acceptance row
// requires an explicit backend-scope review before the Goal denominator changes.
export const inventoryFingerprint = '9d9278464c813a80861c58c49573fc6e2b33d5966da10326ea321e5b86618750';

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
