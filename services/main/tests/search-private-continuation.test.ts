import { expect, test } from 'bun:test';
import { assertPrivateSearchErasureRollback, InvalidPrivateSearchPage,
  narrowPrivateSearchPageLeases, PRIVATE_SEARCH_PAGE_NARROWING_COST,
  PrivateSearchPageRestart, type PrivateSearchPageFence,
  type PrivateSearchPageTarget } from '../src/modules/search-disclosure/private-continuation.ts';

const fence: PrivateSearchPageFence = {
  graphDataEpoch: 'graph-one', graphSequence: '24', indexGeneration: 'index-one',
  sourceDigest: 'b'.repeat(64), resultDigest: 'a'.repeat(64), erasureEpoch: '9',
};
const targets: PrivateSearchPageTarget[] = [
  { key: 'content:resource-one:variant-one', revision: 'revision-one' },
  { key: 'content:resource-two:variant-two', revision: 'revision-two' },
];

test('SEARCH16: each private page receives fresh exact leases and bounded source checks', async () => {
  const calls = { fences: 0, admits: [] as string[], reads: [] as string[], aborts: [] as string[] };
  const page = await narrowPrivateSearchPageLeases(fence, targets, {
    readFence: async () => { calls.fences++; return fence; },
    admit: async target => { calls.admits.push(target.key); return { id: `lease-${target.key}` }; },
    readCurrent: async target => { calls.reads.push(target.revision); return 'available'; },
    abort: async lease => { calls.aborts.push(lease.id); },
  });
  expect(page.leases.map(row => row.lease.id)).toEqual(targets.map(row => `lease-${row.key}`));
  expect(calls).toEqual({ fences: PRIVATE_SEARCH_PAGE_NARROWING_COST.fenceReads,
    admits: targets.map(row => row.key), reads: targets.map(row => row.revision), aborts: [] });
  expect(PRIVATE_SEARCH_PAGE_NARROWING_COST.maxTargets).toBe(64);
});

test('SEARCH16: narrowed authority and erased source abort all newly admitted leases', async () => {
  for (const withdrawn of ['denied', 'erased'] as const) {
    const aborted: string[] = [];
    await expect(narrowPrivateSearchPageLeases(fence, targets, {
      readFence: async () => fence,
      admit: async target => ({ id: target.key }),
      readCurrent: async target => target.key === targets[1]!.key ? withdrawn : 'available',
      abort: async lease => { aborted.push(lease.id); },
    })).rejects.toBeInstanceOf(PrivateSearchPageRestart);
    expect(aborted).toEqual(targets.map(target => target.key));
  }
});

test('SEARCH16: an erased revision cannot reappear after graph or erasure rollback', async () => {
  for (const current of [
    { ...fence, erasureEpoch: '8' },
    { ...fence, graphDataEpoch: 'restored-graph' },
    { ...fence, indexGeneration: 'older-index' },
    { ...fence, sourceDigest: 'c'.repeat(64) },
    { ...fence, resultDigest: 'b'.repeat(64) },
    { ...fence, erasureEpoch: '10' },
  ]) {
    expect(() => assertPrivateSearchErasureRollback(fence, current))
      .toThrow(PrivateSearchPageRestart);
    let admitted = false;
    await expect(narrowPrivateSearchPageLeases(fence, targets, {
      readFence: async () => current,
      admit: async () => { admitted = true; return { id: 'should-not-admit' }; },
      readCurrent: async () => 'available',
      abort: async () => {},
    })).rejects.toBeInstanceOf(PrivateSearchPageRestart);
    expect(admitted).toBe(false);
  }
  expect(() => assertPrivateSearchErasureRollback(fence, fence)).not.toThrow();
});

test('SEARCH16: movement during owner checks aborts leases; malformed or oversized pages fail closed', async () => {
  for (const changed of [{ ...fence, graphSequence: '25' },
    { ...fence, erasureEpoch: '10' }]) {
    const aborted: string[] = [];
    let reads = 0;
    await expect(narrowPrivateSearchPageLeases(fence, targets, {
      readFence: async () => ++reads === 1 ? fence : changed,
      admit: async target => ({ id: target.key }),
      readCurrent: async () => 'available',
      abort: async lease => { aborted.push(lease.id); },
    })).rejects.toBeInstanceOf(PrivateSearchPageRestart);
    expect(aborted).toEqual(targets.map(target => target.key));
  }
  await expect(narrowPrivateSearchPageLeases(fence, [...targets, targets[0]!], {
    readFence: async () => fence, admit: async () => ({ id: 'unexpected' }),
    readCurrent: async () => 'available', abort: async () => {},
  })).rejects.toBeInstanceOf(InvalidPrivateSearchPage);
  await expect(narrowPrivateSearchPageLeases(fence,
    Array.from({ length: 65 }, (_, index) => ({ key: `${index}`, revision: `${index}` })), {
      readFence: async () => fence, admit: async () => ({ id: 'unexpected' }),
      readCurrent: async () => 'available', abort: async () => {},
    })).rejects.toBeInstanceOf(InvalidPrivateSearchPage);
});
