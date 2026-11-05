import { expect, test } from 'bun:test';
import { EMPTY_RECOVERY_LIMITS, emptyRecoveryPrefixes, readEmptyRecovery } from '../../src/search/empty-recovery.ts';

test('empty recovery uses at most two native prefixes and returns only bounded near titles at the same cut', async () => {
  expect(emptyRecoveryPrefixes('prejudise')).toEqual(['pre', 'pr']);
  expect(emptyRecoveryPrefixes('星空')).toEqual(['星']);
  let reads = 0;
  const recovery = await readEmptyRecovery({
    query: 'prejudise',
    asOf: '2026-11-04T00:00:00.000Z',
    actions: [{ kind: 'edit-query' }],
    async read(_prefix, limit) {
      reads++;
      expect(limit).toBe(EMPTY_RECOVERY_LIMITS.candidatesPerRead);
      return {
        asOf: '2026-11-04T00:00:00.000Z',
        candidates: Array.from({ length: 8 }, (_, index) => ({ id: `subject-${index}`, label: 'Pride and Prejudice' })),
      };
    },
  });
  expect(reads).toBe(2);
  expect(recovery.status).toBe('ready');
  expect(recovery.alternatives).toHaveLength(3);
  expect(new TextEncoder().encode(JSON.stringify(recovery)).byteLength).toBeLessThanOrEqual(
    EMPTY_RECOVERY_LIMITS.envelopeBytes,
  );
});

test('recovery refuses mismatched freshness and preserves explicit action advice when a source is preparing', async () => {
  const actions = [
    { kind: 'edit-query' as const },
    { kind: 'remove-facet' as const, property: 'schema:genre', value: 'fiction' },
  ];
  const stale = await readEmptyRecovery({
    query: 'prejudise',
    asOf: 'first-cut',
    actions,
    async read() {
      return { asOf: 'replacement-cut', candidates: [{ id: 'stale', label: 'Pride and Prejudice' }] };
    },
  });
  expect(stale).toEqual({ status: 'unavailable', alternatives: [], actions });
  const preparing = await readEmptyRecovery({
    query: 'prejudise',
    asOf: 'first-cut',
    actions,
    async read() {
      throw new Error('index is preparing');
    },
    failureStatus: () => 'preparing',
  });
  expect(preparing.status).toBe('preparing');
  expect(preparing.actions).toEqual(actions);
});
