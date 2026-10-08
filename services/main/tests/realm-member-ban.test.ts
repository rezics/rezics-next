import { expect, test } from 'bun:test';
import { memberBanView } from '../src/modules/governance/realm-sanction-appeal.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const receiptId = '00000000-0000-4000-8000-000000000002';
const caseId = '00000000-0000-4000-8000-000000000003';
const decider = 'https://rezics.com/id/00000000-0000-4000-8000-000000000099';

function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); keysOf(item, keys); }
  }
  return keys;
}

test('a member ban keeps the resolution time and drops the decider', () => {
  const view = memberBanView({
    realm, receiptId, reason: 'Repeated rule violations', bannedUntil: null, happenedAt: '2026-10-08T00:00:00.000Z',
    decisionActingSubject: decider, decidedAt: '2026-10-09T03:04:00.000Z',
    appeal: { state: 'decided', caseId, statement: 'I appeal.', outcome: 'restore', rationale: 'The ban remains.' },
  });
  expect(view).toEqual({
    realm, receiptId, action: 'ban', reason: 'Repeated rule violations', bannedUntil: null, permanent: true,
    happenedAt: '2026-10-08T00:00:00.000Z',
    appeal: { state: 'decided', caseId, statement: 'I appeal.', outcome: 'restore', rationale: 'The ban remains.',
      decidedAt: '2026-10-09T03:04:00.000Z' },
  });
  const raw = JSON.stringify(view);
  expect(keysOf(view).some(key => /acting.?subject|decider|moderator|principal/i.test(key))).toBe(false);
  expect(raw).not.toContain(decider);
  expect(raw).not.toContain('acting_subject');
  expect(raw).not.toContain('actingSubject');
});

test('an open or absent appeal has no resolution time, and a timed ban is not permanent', () => {
  const open = memberBanView({
    realm, receiptId, reason: 'Repeated rule violations', bannedUntil: '2026-11-01T00:00:00.000Z',
    happenedAt: '2026-10-08T00:00:00.000Z', decisionActingSubject: decider, decidedAt: null,
    appeal: { state: 'open', caseId, statement: 'I appeal.' },
  });
  expect(open.permanent).toBe(false);
  expect(open.bannedUntil).toBe('2026-11-01T00:00:00.000Z');
  expect(open.appeal).toEqual({ state: 'open', caseId, statement: 'I appeal.' });
  expect(open.appeal).not.toHaveProperty('decidedAt');
  expect(JSON.stringify(open)).not.toContain(decider);
  const none = memberBanView({
    realm, receiptId, reason: 'Repeated rule violations', bannedUntil: null, happenedAt: '2026-10-08T00:00:00.000Z',
    decisionActingSubject: null, decidedAt: null, appeal: { state: 'none' },
  });
  expect(none.permanent).toBe(true);
  expect(none.appeal).toEqual({ state: 'none' });
});
