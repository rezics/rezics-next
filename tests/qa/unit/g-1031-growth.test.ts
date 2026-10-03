import { expect, test } from 'bun:test';
import { parseFileStorage, tdbGrowth, type TdbStorageSnapshot } from '../../../scripts/load/tdb-growth.ts';

test('G1031: storage growth keeps preallocation and filesystem blocks distinct', () => {
  expect(parseFileStorage('8388608 16\n16384 32\n')).toEqual({ logicalBytes: 8404992, allocatedBytes: 24576 });
  expect(() => parseFileStorage('')).toThrow();
  expect(() => parseFileStorage('16 -1')).toThrow();
  expect(() => parseFileStorage('9007199254740992 1')).toThrow();
  const before: TdbStorageSnapshot = { tdbLogicalBytes: 8388608, tdbAllocatedBytes: 8192,
    luceneLogicalBytes: 4096, luceneAllocatedBytes: 8192,
    memory: { currentBytes: 10000, peakBytes: 10000, limitBytes: 100000, anonBytes: 5000, fileBytes: 5000 } };
  const after = { ...before, tdbAllocatedBytes: 24576, luceneLogicalBytes: 3072, luceneAllocatedBytes: 4096 };
  expect(tdbGrowth(before, after, 4)).toEqual({ writes: 4, tdbLogicalBytesPerWrite: 0,
    tdbAllocatedBytesPerWrite: 4096, luceneLogicalBytesPerWrite: -256, luceneAllocatedBytesPerWrite: -1024 });
  expect(() => tdbGrowth(before, after, 0)).toThrow();
});
