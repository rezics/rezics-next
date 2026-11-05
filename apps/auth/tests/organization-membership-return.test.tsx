import { expect, test } from 'bun:test';
import { retainMembershipHistory, type MembershipHistory } from '../src/organization-membership-return';

test('first unknown survives later acknowledgement, refusal and discarded review with at most two generic records', () => {
  let history: MembershipHistory = [];
  history = retainMembershipHistory(history, 'unresolved');
  for (const kind of ['acknowledged', 'refused', 'unsent'] as const) {
    history = retainMembershipHistory(history, kind);
    expect(history).toEqual(['unresolved', kind]);
  }
  expect(retainMembershipHistory(history, 'unresolved')).toBe(history);
  expect(retainMembershipHistory([], 'acknowledged')).toEqual(['acknowledged']);
});
