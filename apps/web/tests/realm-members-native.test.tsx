import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readNativeRealmMembers, validateRealmMembersRead } from '../src/community/members/native';

const realmId = '00000000-0000-0000-0000-000000000010';
const accountId = '00000000-0000-0000-0000-000000000020';
const target = { realmId, viewerId: accountId, cursor: 'opaque frontier', accountId };
const unavailable = { state: 'unavailable', reason: 'no_mounted_method' };
const row = {
  accountId,
  episode: 'opaque producer interval',
  membership: 'none',
  identity: null,
  displayName: 'Member',
  banState: 'unknown',
  actions: {
    addMember: unavailable,
    ban: unavailable,
    unban: unavailable,
    removeMember: unavailable,
    reviseRole: unavailable,
  },
};
const page = { realmId, state: 'ready', items: [], next: null, selected: row };

test('exact selection and opaque frontier use one native GET with session credentials only', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(page);
    },
  });
  expect(await readNativeRealmMembers(client, target, 'Bearer admitted')).toEqual({ kind: 'ready', page });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('GET');
  expect(request.headers.get('authorization')).toBe('Bearer admitted');
  expect(request.cache).toBe('no-store');
  expect(new URL(request.url).pathname).toBe(`/v1/realms/${realmId}/members`);
  expect([...new URL(request.url).searchParams]).toEqual([
    ['cursor', target.cursor],
    ['accountId', accountId],
  ]);
  expect(request.body).toBeNull();
});

test('native preparation, denial, concealment and empty remain distinct', async () => {
  for (const [status, body, kind] of [
    [200, { ...page, selected: null }, 'ready'],
    [200, { ...page, state: 'preparing', selected: null }, 'preparing'],
    [403, {}, 'denied'],
    [404, {}, 'concealed'],
    [503, {}, 'unavailable'],
    [400, { code: 'invalid_cursor' }, 'expired'],
  ] as const) {
    const client = createKernelClient('https://kernel.invalid', { fetch: async () => Response.json(body, { status }) });
    expect((await readNativeRealmMembers(client, { ...target, accountId: undefined }, 'Bearer admitted')).kind).toBe(
      kind,
    );
  }
});

test('malformed or mismatched native observations disclose no page', async () => {
  for (const body of [
    { ...page, realmId: accountId },
    { ...page, roles: ['private'] },
    {
      ...page,
      selected: { ...row, identity: { id: accountId, kind: 'actor', state: 'deleted', displayName: 'erased' } },
    },
    { ...page, selected: { ...row, accountId: realmId } },
    { ...page, selected: { ...row, episode: '' } },
    { ...page, items: Array(21).fill({ ...row, membership: 'member' }) },
    { ...page, selected: { ...row, membership: 'pending' } },
    { ...page, selected: { ...row, displayName: 'x'.repeat(4097) } },
    {
      ...page,
      selected: {
        ...row,
        actions: {
          ...row.actions,
          ban: {
            state: 'available',
            method: 'PUT',
            path: '/wrong',
            body: { reason: '' },
            expectedStatus: 200,
            outcome: 'Ban',
          },
        },
      },
    },
  ]) {
    const client = createKernelClient('https://kernel.invalid', { fetch: async () => Response.json(body) });
    expect(await readNativeRealmMembers(client, target, 'Bearer admitted')).toEqual({ kind: 'failed' });
  }
});

test('browser operands are projected and cannot supply credentials, authority or interval', () => {
  expect(
    validateRealmMembersRead({ ...target, authorization: 'forged', authority: 'forged', episode: 'forged' }),
  ).toEqual(target);
  expect(() => validateRealmMembersRead({ ...target, cursor: 'x'.repeat(4097) })).toThrow();
});
