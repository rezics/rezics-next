import { expect, test } from 'bun:test';
import { logByline } from '../src/library/log-contributor';
import { logContribution, logContributionLabel } from '../src/library/log-contribution';

const liveId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';

test('log contribution distinguishes live identity, explicit deletion, and unknown', () => {
  expect(logContribution({ id: liveId, displayName: 'Ada' })).toEqual({
    kind: 'live',
    id: liveId,
    displayName: 'Ada',
  });
  expect(logContribution({ displayName: 'Deleted account' })).toEqual({
    kind: 'deleted',
    displayName: 'Deleted account',
  });
  expect(logContribution({ displayName: 'Deleted organization' })).toEqual({
    kind: 'deleted',
    displayName: 'Deleted organization',
  });
  expect(logContribution(null)).toEqual({ kind: 'unknown' });
  expect(logContribution({ id: liveId, displayName: 'Deleted account' })).toEqual({ kind: 'unknown' });
});

test('log bylines keep live names, deleted labels, and unknown without claiming deletion', () => {
  expect(logContributionLabel({ kind: 'live', id: liveId, displayName: 'Ada' }, 'en')).toBe('Ada');
  expect(logContributionLabel({ kind: 'deleted', displayName: 'Deleted account' }, 'en')).toBe('Deleted account');
  expect(logContributionLabel({ kind: 'deleted', displayName: 'Deleted organization' }, 'en')).toBe(
    'Deleted organization',
  );
  expect(logContributionLabel({ kind: 'unknown' }, 'en')).toBe('Unknown account');
  expect(
    logByline(
      { attribution: { id: liveId, displayName: 'Ada' }, account: { displayName: 'Ada', handle: 'ada' } },
      'en',
    ),
  ).toBe('Ada @ada');
  expect(logByline({ account: { displayName: 'Ada', handle: 'ada' } }, 'en')).toBe('Ada @ada');
  expect(logByline({ attribution: { displayName: 'Deleted account' }, account: null }, 'en')).toBe('Deleted account');
  expect(logByline({ account: null }, 'en')).toBe('Unknown account');
});
