import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  readNativeRealmMembers,
  validateRealmMembersRead,
  type NativeRealmMember,
  type NativeRealmMembersPage,
} from '../src/community/members/native';
import { nativeRealmMembersSource } from '../src/community/members/native-source';

const realmId = '00000000-0000-0000-0000-000000000010';
const accountId = '00000000-0000-0000-0000-000000000020';
const target = { realmId, viewerId: accountId, cursor: 'opaque frontier', accountId };
const unavailable = { state: 'unavailable', reason: 'no_mounted_method' } as const;
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
} satisfies NativeRealmMember;
const page = {
  realmId,
  realmLabel: 'Members Realm',
  pageBound: 20,
  state: 'ready',
  viewer: { accountId, authority: 'opaque-current-authority' },
  items: [],
  next: null,
  selected: row,
} satisfies NativeRealmMembersPage;

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

test('installed GET maps 1/10/20 native rows and one exact selected episode without hydration', async () => {
  for (const count of [1, 10, 20]) {
    const items = Array.from({ length: count }, (_, index) => {
      const id = `00000000-0000-0000-0000-${String(index + 100).padStart(12, '0')}`;
      return {
        ...row,
        accountId: id,
        membership: 'member' as const,
        // The native schema admits disclosed handles as bounded text.
        identity: { id, kind: 'actor' as const, state: 'active' as const, handle: 'Mixed.Name', displayName: null },
      };
    });
    const selected = items.at(-1)!;
    const requests: URL[] = [];
    const next = ' opaque/+==? &字 ';
    const client = createKernelClient('https://kernel.invalid', {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        requests.push(url);
        return Response.json({ ...page, items, next, selected: url.searchParams.has('accountId') ? selected : null });
      },
    });
    const source = nativeRealmMembersSource(accountId, (input) =>
      readNativeRealmMembers(client, input, 'Bearer admitted'),
    );
    const read = await source.readPage({ realmId, cursor: null });
    expect(read).toMatchObject({ kind: 'ready', page: { authority: page.viewer.authority, next } });
    expect(read.kind === 'ready' && read.page.rows).toHaveLength(count);
    expect([source.pageBound, requests.length]).toEqual([20, 1]);
    expect([...requests[0]!.searchParams]).toEqual([]);
    expect(
      await source.readSelected({ realmId, accountId: selected.accountId, authority: page.viewer.authority }),
    ).toMatchObject({
      kind: 'ready',
      identity: { accountId: selected.accountId, reference: 'Mixed.Name', label: selected.displayName },
      membership: 'current',
      membershipInterval: selected.episode,
      membershipEpisode: selected.episode,
      advice: { add: 'unavailable', ban: 'unavailable', unban: 'unavailable' },
    });
    expect(requests).toHaveLength(2);
    expect([...requests[1]!.searchParams]).toEqual([['accountId', selected.accountId]]);
  }
});

test('native preparation, denial, concealment and empty remain distinct', async () => {
  for (const [status, body, kind] of [
    [200, { ...page, selected: null }, 'ready'],
    [200, { ...page, state: 'preparing', viewer: null, items: [], selected: null }, 'preparing'],
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
    { ...page, viewer: { accountId: realmId, authority: 'another-viewer' } },
    { ...page, viewer: { accountId, authority: 'x'.repeat(65) } },
    { ...page, viewer: { accountId, authority: 'ok', private: 'extra' } },
    ...[1, 10, 21].map((pageBound) => ({ ...page, pageBound })),
    { ...page, viewer: null },
    { ...page, items: Array(2).fill({ ...row, membership: 'member' }) },
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

test('closed action advice admits only the selected Realm and mounted Accounts or ban operands', async () => {
  const advice = {
    addMember: {
      state: 'available',
      method: 'POST',
      path: `/v1/realms/${realmId}/members`,
      body: { accountId },
      expectedStatus: 202,
      outcome: 'Accepted; a membership workflow may still be pending.',
    },
    ban: {
      state: 'available',
      method: 'PUT',
      path: `/v1/realms/${realmId}/bans/${accountId}`,
      body: { reason: '' },
      expectedStatus: 200,
      outcome: 'Ban commits; membership removal may still be pending.',
    },
    unban: {
      state: 'available',
      method: 'DELETE',
      path: `/v1/realms/${realmId}/bans/${accountId}`,
      body: null,
      expectedStatus: 204,
      outcome: 'Unban commits without restoring membership or follow.',
    },
    removeMember: unavailable,
    reviseRole: unavailable,
  };
  const selected = {
    ...row,
    membership: 'none',
    identity: { id: accountId, kind: 'actor', state: 'active', handle: null, displayName: 'Member' },
    actions: advice,
  };
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) =>
      Response.json({
        ...page,
        selected: new URL(new Request(input, init).url).searchParams.has('accountId') ? selected : null,
      }),
  });
  expect(await readNativeRealmMembers(client, { ...target, cursor: undefined }, 'Bearer admitted')).toMatchObject({
    kind: 'ready',
    page: { selected: { actions: advice } },
  });

  const source = nativeRealmMembersSource(accountId, (input) =>
    readNativeRealmMembers(client, input, 'Bearer admitted'),
  );
  await source.readPage({ realmId, cursor: null });
  expect(await source.readSelected({ realmId, accountId, authority: page.viewer.authority })).toMatchObject({
    kind: 'ready',
    authority: page.viewer.authority,
    membership: 'none',
    membershipInterval: null,
    membershipEpisode: selected.episode,
    advice: { add: 'available', ban: 'available', unban: 'available' },
  });

  for (const actions of [
    { ...advice, removeMember: advice.ban },
    { ...advice, addMember: { ...advice.addMember, body: { accountId: realmId } } },
  ]) {
    const rejectingClient = createKernelClient('https://kernel.invalid', {
      fetch: async () => Response.json({ ...page, selected: { ...selected, actions } }),
    });
    expect(await readNativeRealmMembers(rejectingClient, { ...target, cursor: undefined }, 'Bearer admitted')).toEqual({
      kind: 'failed',
    });
  }
});
