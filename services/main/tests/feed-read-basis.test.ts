import { expect, spyOn, test } from 'bun:test';
import { retainedMembershipBasis, retainedMembershipFamilies } from '../src/modules/read-basis/membership.ts';
import { READ_BASIS_RETENTION_MS } from '../src/modules/read-basis/retention.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadExpired, WorkReadInvalid } from '../src/modules/work/read-session.ts';

for (const family of Object.keys(retainedMembershipFamilies) as (keyof typeof retainedMembershipFamilies)[]) {
  test(`${family} retains membership across graph writes and never renews its first-page deadline`, () => {
    const binding = [family, 'reader', 'query'], position = { dataEpoch: 'epoch', sequence: '7' };
    let now = 1_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = retainedMembershipBasis(family, undefined, binding, position);
      const token = first.encode('item-one', 'owner-key');
      now += READ_BASIS_RETENTION_MS - 1;
      const next = retainedMembershipBasis(family, token, binding, { ...position, sequence: '999' });
      expect(next.cursor?.after).toBe('item-one');
      const continued = next.encode('item-two', 'next-key');
      expect(decodeReadCursor(continued, binding, { ...position, sequence: '999' }, true)?.expiresAt)
        .toBe(1_000_000 + READ_BASIS_RETENTION_MS);
      expect(() => retainedMembershipBasis(family, token, [family, 'other', 'query'], position))
        .toThrow(WorkReadInvalid);
      expect(() => retainedMembershipBasis(family, token, binding, { ...position, dataEpoch: 'restored' }))
        .toThrow(WorkReadExpired);
      now++;
      expect(() => retainedMembershipBasis(family, continued, binding, position)).toThrow(WorkReadExpired);
      expect(() => next.assertLive()).toThrow(WorkReadExpired);
      expect(() => next.encode('late', 'key')).toThrow(WorkReadExpired);
    } finally { clock.mockRestore(); }
  });
}

test('a retained membership family rejects cursors without a fixed deadline and mismatched registration', () => {
  const position = { dataEpoch: 'epoch', sequence: '7' }, binding = ['home-feed-v1'];
  const legacy = encodeReadCursor(binding, position, 'item', 'key');
  expect(() => retainedMembershipBasis('home-feed-v1', legacy, binding, position)).toThrow(WorkReadExpired);
  expect(() => retainedMembershipBasis('realm-threads-v1', undefined, binding, position))
    .toThrow('family differs');
  const ordinary = encodeReadCursor(['ordinary'], position, 'item', 'key', Date.now() + READ_BASIS_RETENTION_MS);
  expect(() => decodeReadCursor(ordinary, ['ordinary'], { ...position, sequence: '8' }))
    .toThrow(WorkReadExpired);
});
