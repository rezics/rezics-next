import { expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import { refreshMetadataBasis } from './metadata.ts';

test('G-543: metadata seed refreshes the snapshot before a new admission attempt', async () => {
  const snapshots: string[] = [];
  const result = await refreshMetadataBasis(async attempt => {
    const snapshot = `head-${attempt}`;
    snapshots.push(snapshot);
    if (attempt === 0) throw new SeedApiError('metadata', 409, JSON.stringify({ code: 'metadata_basis_changed' }));
    return { expectedHead: snapshot, key: `metadata:${snapshot}:${attempt}` };
  });
  expect(snapshots).toEqual(['head-0', 'head-1']);
  expect(result).toEqual({ expectedHead: 'head-1', key: 'metadata:head-1:1' });
});

test('G-543: metadata refresh is bounded and other conflicts stay visible', async () => {
  let calls = 0;
  await expect(refreshMetadataBasis(async () => {
    calls++;
    throw new SeedApiError('metadata', 409, JSON.stringify({ code: 'metadata_basis_changed' }));
  })).rejects.toThrow('HTTP 409');
  expect(calls).toBe(4);
  calls = 0;
  await expect(refreshMetadataBasis(async () => {
    calls++;
    throw new SeedApiError('metadata', 409, JSON.stringify({ code: 'idempotency_key_reused' }));
  })).rejects.toThrow('HTTP 409');
  expect(calls).toBe(1);
});
