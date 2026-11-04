import { expect, test } from 'bun:test';
import type { NativeRealmMember, NativeRealmMembersRead, RealmMembersReadInput } from '../src/community/members/native';
import { nativeRealmMembersSource } from '../src/community/members/native-source';

const realmId = '00000000-0000-0000-0000-000000000010';
const viewerId = '00000000-0000-0000-0000-000000000020';
const accountId = '00000000-0000-0000-0000-000000000030';
const episode = 'mep1.0.producer-owned-episode';
const unavailable = { state: 'unavailable' as const, reason: 'no_mounted_method' as const };

function member(overrides: Partial<NativeRealmMember> = {}): NativeRealmMember {
  return {
    accountId,
    episode,
    membership: 'member',
    identity: { id: accountId, kind: 'actor', state: 'active', handle: 'member', displayName: 'Member name' },
    displayName: 'Member name',
    banState: 'clear',
    actions: {
      addMember: { state: 'prohibited', reason: 'already_member' },
      ban: {
        state: 'available',
        method: 'PUT',
        path: `/v1/realms/${realmId}/bans/${accountId}`,
        body: { reason: '' },
        expectedStatus: 200,
        outcome: 'Ban commits.',
      },
      unban: { state: 'uncertain', reason: 'authority_unavailable' },
      removeMember: unavailable,
      reviseRole: unavailable,
    },
    ...overrides,
  };
}

function response(
  selected: NativeRealmMember | null,
  items: NativeRealmMember[] = [member()],
): NativeRealmMembersRead {
  return {
    kind: 'ready',
    page: {
      realmId,
      realmLabel: 'Exact Realm',
      pageBound: 20,
      state: 'ready',
      viewer: { accountId: viewerId, authority: 'mra1.0.authority-proof' },
      items,
      next: null,
      selected,
    },
  };
}

test('production source binds native viewer and page bound, preserves cursor and episode bytes, and maps closed advice', async () => {
  const operands: RealmMembersReadInput[] = [];
  const reader = async (input: RealmMembersReadInput) => {
    operands.push(input);
    return input.accountId
      ? response(member())
      : response(null, [member()]);
  };
  const source = nativeRealmMembersSource(viewerId, reader);
  const page = await source.readPage({ realmId, cursor: ' opaque/+==? &字 ' });
  expect(operands).toEqual([{ realmId, cursor: ' opaque/+==? &字 ', viewerId }]);
  expect(source.pageBound).toBe(20);
  expect(page).toEqual({
    kind: 'ready',
    page: {
      realm: { id: realmId, label: 'Exact Realm' },
      authority: 'mra1.0.authority-proof',
      rows: [
        {
          kind: 'disclosed',
          identity: { accountId, reference: 'member', label: 'Member name' },
          membershipInterval: episode,
          membership: 'current',
        },
      ],
      next: null,
    },
  });

  const selected = await source.readSelected({
    realmId,
    accountId,
    membershipInterval: episode,
    authority: 'mra1.0.authority-proof',
  });
  expect(operands[1]).toEqual({ realmId, accountId, viewerId });
  expect(selected).toEqual({
    kind: 'ready',
    realmId,
    authority: 'mra1.0.authority-proof',
    identity: { accountId, reference: 'member', label: 'Member name' },
    membershipInterval: episode,
    membershipEpisode: episode,
    membership: 'current',
    advice: { add: 'unavailable', ban: 'available', unban: 'unknown' },
  });
});

test('none stays absence, carries the exact episode, and never falls back to a concealed identity', async () => {
  let current: NativeRealmMembersRead = response(
    member({
      episode: 'mep1.0-absence-proof',
      membership: 'none',
      actions: {
        addMember: {
          state: 'available',
          method: 'POST',
          path: `/v1/realms/${realmId}/members`,
          body: { accountId },
          expectedStatus: 202,
          outcome: 'Accepted; a membership workflow may still be pending.',
        },
        ban: unavailable,
        unban: unavailable,
        removeMember: unavailable,
        reviseRole: unavailable,
      },
    }),
    [],
  );
  const source = nativeRealmMembersSource(viewerId, async () => current);
  await source.readPage({ realmId, cursor: null });
  expect(
    await source.readSelected({ realmId, accountId, authority: 'mra1.0.authority-proof' }),
  ).toMatchObject({
    kind: 'ready',
    membership: 'none',
    membershipInterval: null,
    membershipEpisode: 'mep1.0-absence-proof',
    advice: { add: 'available' },
  });

  current = response(member({ identity: null }));
  expect(
    await source.readSelected({ realmId, accountId, authority: 'mra1.0.authority-proof' }),
  ).toEqual({ kind: 'concealed' });
});

