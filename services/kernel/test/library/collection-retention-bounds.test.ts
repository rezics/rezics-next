import { expect, test } from 'bun:test';
import {
  collectionRetentionMaximumStatement,
  collectionRetentionQueryBound,
} from '../../src/library/collection-retention-bounds.ts';
import collectionTombstone from '../../src/library/collection-store-collection-tombstone.sql';

test('tombstone ceiling includes the native PostgreSQL timestamp bind', () => {
  const actual = collectionRetentionQueryBound('tombstone', collectionTombstone.sql, {
    route: 65535,
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    transaction_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    time: '2026-11-07 12:34:56.123456+00',
  });
  const maximum = collectionRetentionMaximumStatement('tombstone');

  // The observed timestamptz::text operand is 29 bytes; its old ISO ceiling was 27.
  expect(actual.bytes).toBe(maximum.bytes - 2);
});
