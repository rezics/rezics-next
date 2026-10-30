import { expect, test } from 'bun:test';
import {
  membershipProfile,
  membershipReadback,
  newMembershipCommand,
  parseSelectedMembership,
} from '../src/organization-membership';
const organizationId = '00000000-0000-4000-8000-000000000001';
const memberAccountId = '00000000-0000-4000-8000-000000000002';
const reservationId = '00000000-0000-4000-8000-000000000003';
const selection = { organizationId, memberAccountId };
test('selected member native state closes the response and immutable command readback keeps the exact reservation', () => {
  expect(membershipProfile()).toEqual({
    client_id: 'rezics-auth-account-management',
    scope: ['organization:membership'],
  });
  const command = newMembershipCommand(memberAccountId, {
    kind: 'membership',
    ...selection,
    role: 'owner',
    reservationId,
  });
  expect(Object.isFrozen(command.operation)).toBe(true);
  const current = parseSelectedMembership(
    { ...selection, membership: { role: 'owner', reservationId } },
    organizationId,
    memberAccountId,
  );
  expect(membershipReadback(command, current)).toBe(true);
  expect(
    membershipReadback(
      command,
      parseSelectedMembership({ ...selection, membership: null }, organizationId, memberAccountId),
    ),
  ).toBe(false);
  expect(
    membershipReadback(
      command,
      parseSelectedMembership(
        { ...selection, membership: { role: 'owner', reservationId: organizationId } },
        organizationId,
        memberAccountId,
      ),
    ),
  ).toBe(false);
  expect(
    parseSelectedMembership({ ...selection, membership: null, holders: [] }, organizationId, memberAccountId).kind,
  ).toBe('unavailable');
  expect(
    parseSelectedMembership(
      { ...selection, membership: { role: 'owner', reservationId }, operator: {} },
      organizationId,
      memberAccountId,
    ).kind,
  ).toBe('unavailable');
});
