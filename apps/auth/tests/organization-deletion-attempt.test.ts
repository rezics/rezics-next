import { expect, test } from 'bun:test';
import { organizationDeletionAttempt, warnOrganizationDeletionAttempt } from '../src/organization-deletion-attempt';

test('historical uncertainty is bound to an immutable mounted identity independently of review authority', () => {
  const identity = { organizationId: 'original', humanAccountId: 'human', operationKey: 'key' };
  const attempt = organizationDeletionAttempt(identity, true);
  identity.organizationId = 'replacement';
  expect(attempt.identity.organizationId).toBe('original');
  expect(Object.isFrozen(attempt.identity)).toBe(true);
  expect(warnOrganizationDeletionAttempt(attempt, 'original')).toBe(true);
  expect(warnOrganizationDeletionAttempt(attempt, 'replacement')).toBe(false);
  attempt.mounted = false;
  expect(warnOrganizationDeletionAttempt(attempt, 'original')).toBe(false);
  expect(attempt.unresolved).toBe(true);
  expect(warnOrganizationDeletionAttempt(organizationDeletionAttempt(identity), 'replacement')).toBe(false);
});
