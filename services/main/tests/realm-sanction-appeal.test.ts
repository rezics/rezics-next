import { expect, test } from 'bun:test';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid } from '../src/modules/governance/store.ts';
import { appealStatement, appealView, idempotencyReplay, isBanReceipt, openAppealConflict,
  publicResolution, realmModerator, sanctionedPrincipal } from '../src/modules/governance/realm-sanction-appeal.ts';

const decider = 'https://rezics.com/id/00000000-0000-4000-8000-000000000099';

function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); keysOf(item, keys); }
  }
  return keys;
}

test('a ban receipt is the member action, with a legacy reason reference as fallback', () => {
  const present = { memberPresent: true, resultBanned: true, reasonRefMatches: true, banActive: true };
  expect(isBanReceipt({ ...present, memberAction: 'ban' })).toBe(true);
  expect(isBanReceipt({ ...present, memberAction: 'ban', banActive: false, reasonRefMatches: false })).toBe(true);
  expect(isBanReceipt({ ...present, memberAction: 'unban' })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: 'remove' })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: 'add' })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: null })).toBe(true);
  expect(isBanReceipt({ ...present, memberAction: null, banActive: false })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: null, reasonRefMatches: false })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: null, resultBanned: false })).toBe(false);
  expect(isBanReceipt({ ...present, memberAction: 'ban', memberPresent: false })).toBe(false);
});

test('appeal statements stay trimmed and within the receipt bound', () => {
  expect(appealStatement('I was banned in error.')).toBe('I was banned in error.');
  expect(appealStatement('a'.repeat(2000))).toHaveLength(2000);
  expect(() => appealStatement(' padded')).toThrow(GovernanceInvalid);
  expect(() => appealStatement('')).toThrow(GovernanceInvalid);
  expect(() => appealStatement('a'.repeat(2001))).toThrow(GovernanceInvalid);
});

test('sanction guards refuse the wrong principal, a second open appeal, and a hidden read', () => {
  expect(() => sanctionedPrincipal(false)).toThrow(GovernanceDenied);
  expect(() => sanctionedPrincipal(true)).not.toThrow();
  expect(() => openAppealConflict(true)).toThrow(GovernanceConflict);
  expect(() => openAppealConflict(false)).not.toThrow();
  expect(() => realmModerator(false)).toThrow(GovernanceDenied);
  expect(() => realmModerator(true)).not.toThrow();
  expect(idempotencyReplay({ caseId: 'case-1', digest: 'abc', state: 'open' }, 'abc')).toEqual({ caseId: 'case-1', state: 'open' });
  expect(() => idempotencyReplay({ caseId: 'case-1', digest: 'abc', state: 'open' }, 'other')).toThrow(GovernanceConflict);
  expect(idempotencyReplay(null, 'abc')).toBeNull();
});

test('the appeal read drops the decider identity from the whole document', () => {
  const view = appealView({
    realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    receiptId: '00000000-0000-4000-8000-000000000002',
    reason: 'Repeated rule violations', bannedUntil: null, happenedAt: '2026-10-08T00:00:00.000Z',
    decisionActingSubject: decider,
    appeal: { state: 'decided', caseId: '00000000-0000-4000-8000-000000000003', statement: 'I appeal.',
      outcome: 'restore', rationale: 'The ban remains in place.' },
  });
  const raw = JSON.stringify(publicResolution(view));
  expect(view.appeal).toEqual({ state: 'decided', caseId: '00000000-0000-4000-8000-000000000003',
    statement: 'I appeal.', outcome: 'restore', rationale: 'The ban remains in place.' });
  expect(keysOf(view).some(key => /acting.?subject|decider|moderator|principal/i.test(key))).toBe(false);
  expect(raw).not.toContain(decider);
  expect(raw).not.toContain('acting_subject');
  expect(raw).not.toContain('actingSubject');
});
