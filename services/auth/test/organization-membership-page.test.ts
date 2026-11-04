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
