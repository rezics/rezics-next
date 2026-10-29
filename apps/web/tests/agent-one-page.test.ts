import { expect, test } from 'bun:test';
import { loadSubjectPage } from '../src/features/pages/subject';
import { accountOf } from '../src/features/pages/account-read';

const redirectedClient = (data: unknown) => ({
  pages: { $read: { post: async () => ({ status: 200, data }) } },
}) as never;

test('a subject read redirected to an account handle is treated as an agent redirect', async () => {
  const result = await loadSubjectPage(
    redirectedClient({ subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81', reads: {} }),
    '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80',
    'reviews',
    'zh-Hans',
  );
  expect(result).toEqual({ kind: 'redirect', id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81' });
});

test('account profiles preserve automation and the public identity operator id', () => {
  const profile = accountOf({ accounts: [{
    id: 'automated-account', state: 'active', kind: 'actor', automated: true,
    operatorId: 'operator-account', handle: 'helper', links: [],
  }] });
  expect(profile).toMatchObject({ automated: true, operatorId: 'operator-account' });
});

test('ordinary and organization account descriptors remain distinguishable', () => {
  expect(accountOf({ accounts: [{ id: 'person', state: 'active', kind: 'actor', links: [] }] })?.kind).toBe('actor');
  expect(accountOf({ accounts: [{ id: 'org', state: 'active', kind: 'organization', links: [] }] })?.kind).toBe('organization');
});
