import { expect, test } from 'bun:test';
import { parseGuardianPage, parseRecoveryPolicy } from '../features/api/recovery-policy.ts';
import { classifyFailure } from '../features/api/errors.ts';

const invitationId = '80000000-0000-4000-8000-000000000001';
const expiresAt = '2026-11-01T12:00:00Z';

test('recovery enrollment distinguishes a wrong password from an uncertain server outcome', () => {
  expect(classifyFailure(403, { error: 'invalid_password' })).toBe('invalid-credentials');
  expect(classifyFailure(503, { error: 'temporarily_unavailable' })).toBe('unavailable');
});

test('recovery contracts preserve absent policy, consent states and code availability without coercing missing fields', () => {
  expect(parseRecoveryPolicy({ policy: null })).toEqual({ policy: null });
  const policy = {
    invitationId,
    guardianEmail: 'friend@example.test',
    state: 'withdrawn' as const,
    expiresAt,
    hasCode: false,
  };
  expect(parseRecoveryPolicy({ policy })).toEqual({ policy });
  expect(parseRecoveryPolicy({})).toBeNull();
  expect(parseRecoveryPolicy({ policy: { ...policy, hasCode: undefined } })).toBeNull();
  expect(parseRecoveryPolicy({ policy: { ...policy, state: 'assigned' } })).toBeNull();
  expect(parseRecoveryPolicy({ policy: { ...policy, expiresAt: 'invalid' } })).toBeNull();
});

test('guardian pages keep the continuation and reject malformed or mixed authorization states', () => {
  const item = {
    invitationId,
    ownerEmail: 'owner@example.test',
    state: 'pending' as const,
    expiresAt,
  };
  expect(parseGuardianPage({ items: [item], nextCursor: invitationId })).toEqual({
    items: [item],
    nextCursor: invitationId,
  });
  expect(parseGuardianPage({ items: [], nextCursor: null })).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(parseGuardianPage({ items: [item] })).toBeNull();
  expect(
    parseGuardianPage({ items: [{ ...item, state: 'expired' }], nextCursor: null }),
  ).toBeNull();
  expect(
    parseGuardianPage({ items: [item, { ...item, ownerEmail: null }], nextCursor: null }),
  ).toBeNull();
});
