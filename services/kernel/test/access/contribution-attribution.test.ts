import { expect, test } from 'bun:test';
import {
  contributionAttribution,
  contributionDeleted,
  contributionFromPublicIdentity,
} from '../../src/access/contribution-attribution.ts';

const live = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', displayName: 'Ada', state: 'active' as const };

test('observed contribution keeps live identity, id-free deletion, and unknown pending or missing', () => {
  expect(contributionFromPublicIdentity(live)).toEqual({ id: live.id, displayName: 'Ada' });
  expect(contributionFromPublicIdentity({ accountId: live.id, kind: 'actor', state: 'deleted' })).toEqual({
    displayName: 'Deleted account',
  });
  expect(contributionFromPublicIdentity({ id: live.id, kind: 'organization', state: 'deleted' })).toEqual({
    displayName: 'Deleted organization',
  });
  expect(contributionFromPublicIdentity(null)).toBeNull();
  expect(contributionFromPublicIdentity({ id: live.id, state: 'pending' })).toBeNull();
});

test('deletion labels have no account id; missing identities are not treated as deleted', () => {
  const deleted = contributionAttribution({ id: live.id, kind: 'actor', state: 'deleted' });
  expect(contributionDeleted(deleted)).toBe(true);
  expect(deleted).toEqual({ displayName: 'Deleted account' });
  expect(contributionFromPublicIdentity(undefined)).toBeNull();
});
