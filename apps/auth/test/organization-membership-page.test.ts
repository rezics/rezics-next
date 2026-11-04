import { expect, test } from 'bun:test';
import { parseMembershipPage } from '../src/organization-membership';

const organizationId = '00000000-0000-4000-8000-000000000001';
const viewerId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';

test('keeps viewer-bound public identity and native advice while preserving unavailable inventory', () => {
  const page = parseMembershipPage(
    {
      organizationId,
      viewer: { accountId: viewerId, role: 'owner', leave: 'unavailable' },
      members: {
        state: 'ready',
        items: [
          {
            accountId: memberId,
            account: { id: memberId, kind: 'actor', handle: null, displayName: null },
            role: 'owner',
            actions: { changeRole: 'last-owner', remove: 'last-owner' },
          },
        ],
        next: null,
      },
    },
    organizationId,
    viewerId,
  );
  expect(page.kind).toBe('ready');
  if (page.kind !== 'ready') return;
  expect(page.members.state).toBe('ready');
  expect(page.members.state === 'ready' && page.members.holders[0]?.account?.displayName).toBeNull();
  expect(page.members.state === 'ready' && page.members.holders[0]?.actions.remove).toBe('last-owner');
  expect(
    parseMembershipPage(
      {
        organizationId,
        viewer: { accountId: viewerId, role: 'member', leave: 'unavailable' },
        members: { state: 'unavailable' },
      },
      organizationId,
      viewerId,
    ),
  ).toEqual({
    kind: 'ready',
    organizationId,
    viewer: { accountId: viewerId, role: 'member', leave: 'unavailable' },
    members: { state: 'unavailable' },
  });
});
