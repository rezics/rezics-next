import { expect, test } from 'bun:test';
import { organizationMembershipPage } from '../src/organization-membership-page.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const viewerId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';

test('allows only bounded disclosed identity, role and action advice across the Auth page boundary', () => {
  const page = organizationMembershipPage(
    {
      organizationId,
      viewer: { accountId: viewerId, role: 'owner', leave: 'unavailable' },
      members: {
        state: 'ready',
        items: [
          {
            accountId: memberId,
            account: { id: memberId, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' },
            role: 'member',
            actions: { changeRole: 'allowed', remove: 'allowed' },
          },
        ],
        next: null,
      },
    },
    organizationId,
    viewerId,
  );
  expect(page.members.state === 'ready' && page.members.items[0]?.account).toEqual({
    id: memberId,
    kind: 'actor',
    handle: 'reader',
    displayName: 'Rae Reader',
  });
  expect(() =>
    organizationMembershipPage(
      {
        organizationId,
        viewer: { accountId: viewerId, role: 'owner', leave: 'unavailable' },
        members: {
          state: 'ready',
          items: [
            {
              accountId: memberId,
              account: { id: memberId, kind: 'actor', handle: 'reader', displayName: 'Rae Reader' },
              role: 'member',
              actions: { changeRole: 'allowed', remove: 'allowed' },
              privateEmail: 'private@example.test',
            },
          ],
          next: null,
        },
      },
      organizationId,
      viewerId,
    ),
  ).toThrow();
  expect(() =>
    organizationMembershipPage(
      {
        organizationId,
        viewer: { accountId: viewerId, role: 'member', leave: 'last-owner' },
        members: { state: 'unavailable' },
      },
      organizationId,
      viewerId,
    ),
  ).toThrow();
});

test('maximum escaped native roster is bounded, with opaque viewer identity and exact UUID rows', async () => {
  const { membershipResponseBytes } = await import('@rezics/auth-contract');
  const viewer = '\0'.repeat(1024);
  const items = Array.from({ length: 20 }, (_, n) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    return {
      accountId: id,
      account: { id, kind: 'organization', handle: '\0'.repeat(256), displayName: '\0'.repeat(256) },
      role: 'member',
      actions: { changeRole: 'unavailable', remove: 'unavailable' },
    };
  });
  const body = {
    organizationId,
    viewer: { accountId: viewer, role: 'member', leave: 'unavailable' },
    members: { state: 'ready', items, next: '\0'.repeat(4096) },
  };
  expect(
    new TextEncoder().encode(JSON.stringify(organizationMembershipPage(body, organizationId, viewer))).length,
  ).toBe(membershipResponseBytes.roster);
  for (const bad of [
    { ...body, viewer: { ...body.viewer, accountId: viewer + 'x' } },
    { ...body, members: { ...body.members, items: [items[0], items[0]] } },
    { ...body, members: { ...body.members, items: [{ ...items[0], accountId: 'opaque' }] } },
    { ...body, members: { ...body.members, items: [{ ...items[0], role: 'admin' }] } },
  ])
    expect(() => organizationMembershipPage(bad, organizationId, bad.viewer.accountId)).toThrow();
});
