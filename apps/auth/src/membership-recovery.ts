import type { MembershipCommand, MembershipPage, SelectedMembership } from './organization-membership';

export function isUnresolvedMembership(command: MembershipCommand | null, observed: boolean) {
  return command?.unresolved === true && !observed;
}

export function sameMembershipCommand(
  saved: MembershipCommand | null | 'invalid',
  expected: MembershipCommand,
) {
  return saved !== null && saved !== 'invalid' && JSON.stringify(saved) === JSON.stringify(expected);
}

export function membershipPageAllowsCommand(page: MembershipPage, command: MembershipCommand) {
  const operation = command.operation;
  if (page.kind !== 'ready' || page.organizationId !== operation.organizationId || page.viewer.accountId !== command.accountId)
    return false;
  if (page.viewer.role === 'member')
    return operation.role === null && page.viewer.accountId === operation.memberAccountId && page.viewer.leave === 'allowed';
  if (page.viewer.role !== 'owner') return false;
  const target =
    page.members.state === 'ready'
      ? page.members.holders.find((holder) => holder.accountId === operation.memberAccountId)
      : undefined;
  if (!target) return true;
  return operation.role === null ? target.actions.remove === 'allowed' : target.actions.changeRole === 'allowed';
}

export function membershipReservationMatches(command: MembershipCommand, current: SelectedMembership) {
  return (
    current.kind === 'ready' &&
    current.organizationId === command.operation.organizationId &&
    current.memberAccountId === command.operation.memberAccountId &&
    current.membership !== null &&
    !!command.operation.reservationId &&
    current.membership.reservationId === command.operation.reservationId
  );
}
