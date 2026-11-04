import { expect, test } from 'bun:test';
import { accountBiography } from '../../src/search/account-context.ts';
import { discoveryHttpPage } from '../../src/search/discovery-http.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';
const id = '018f0000-0000-7000-8000-00a000000001';
const target = '018f0000-0000-7000-8000-00a000000002';
function page(): DiscoveryPage {
  return { hits: [{ key: { owner: 'accounts', kind: 'account', route: 160, id }, summary: { kind: 'account', value: {
    id, accountKind: 'actor', handle: 'live', displayName: 'Same name', automated: false, operatorId: null, avatar: null, verifiedAgent: null,
    context: { biography: accountBiography('Current public bio'), followTarget: { state: 'available', id: target, label: 'Native person', type: 'schema:Person', source: 'a'.repeat(64) } },
  } } }], as_of: '2026-11-01T00:00:00Z', kinds: { values: [], next: null }, next: 'unchanged-cursor',
  accountFollows: { state: 'current', accountId: id, partition: 10, rows: [{ targetId: target, targetType: 'subject', source: 'a'.repeat(64), following: false, actions: { follow: true, unfollow: false } }] } };
}
test('Account native context closes and detaches public identity and exactly bound private advice', () => {
  const native = page(), wire = discoveryHttpPage(native), retained = structuredClone(wire);
  const summary = native.hits[0]!.summary;
  if (summary.kind !== 'account') throw new Error('Expected Account');
  summary.value.context!.biography = { state: 'withheld' };
  expect(wire).toEqual(retained);
  for (const field of ['targetId', 'targetType', 'source'] as const) {
    const invalid = page();
    if (invalid.accountFollows?.state !== 'current') throw new Error('Expected advice');
    Reflect.set(invalid.accountFollows.rows[0]!, field, field === 'targetId' ? id : 'wrong');
    expect(() => discoveryHttpPage(invalid)).toThrow();
  }
  expect(accountBiography('😀'.repeat(257))).toEqual({ state: 'available', text: '😀'.repeat(256), truncated: true });
  expect(accountBiography(null)).toEqual({ state: 'absent' });
  expect(accountBiography(undefined)).toEqual({ state: 'unavailable' });
});
