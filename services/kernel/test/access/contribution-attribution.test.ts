import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  contributionAttribution,
  contributionDeleted,
  contributionFromPublicIdentity,
  ContributionAttributionSchema,
} from '../../src/access/contribution-attribution.ts';

const id = '00000000-0000-8000-8000-123400000001';

test('only authoritative deletion de-identifies retained people and organizations', () => {
  for (const kind of ['actor', 'organization'] as const) {
    const live = { id, kind, state: 'active', displayName: 'Current name', handle: 'current' };
    expect(contributionAttribution(live)).toEqual({ id, kind, displayName: 'Current name' });
    expect(contributionAttribution({ ...live, state: 'suspended' })).toEqual({ id, kind, displayName: 'Current name' });
    expect(contributionAttribution({ ...live, displayName: 'Deleted account' })).toEqual({
      id,
      kind,
      displayName: 'Deleted account',
    });
    const deleted = contributionAttribution({ ...live, state: 'deleted' });
    expect(deleted).toEqual({ displayName: kind === 'organization' ? 'Deleted organization' : 'Deleted account' });
    expect(contributionDeleted(deleted)).toBe(true);
    expect(Value.Check(ContributionAttributionSchema(), deleted)).toBe(true);
    expect(Value.Check(ContributionAttributionSchema(), { ...deleted, id })).toBe(false);
  }
});

test('optional absence, pending owners and missing ids remain unavailable rather than deleted', () => {
  for (const identity of [null, undefined, {}, { state: 'active' }, { id, state: 'pending' }]) {
    const attribution = contributionAttribution(identity);
    expect(attribution).toBeNull();
    expect(contributionDeleted(attribution)).toBe(false);
    expect(Value.Check(ContributionAttributionSchema(), attribution)).toBe(true);
  }
  expect(contributionAttribution({ accountId: id, kind: 'organization', state: 'active' })).toEqual({
    id,
    kind: 'organization',
    displayName: null,
  });
});

test('deletion detection requires an explicit tombstone, including during partial enrichment', () => {
  for (const value of [undefined, null, {}, { displayName: null }, { displayName: 'Current name' }]) {
    expect(contributionDeleted(value)).toBe(false);
  }
  expect(contributionDeleted({ id, displayName: 'Deleted account' })).toBe(false);
  expect(contributionDeleted({ displayName: 'Deleted account' })).toBe(true);
  expect(contributionDeleted({ displayName: 'Deleted organization' })).toBe(true);
});

const live = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', displayName: 'Ada', state: 'active' as const };

test('observed contribution keeps live identity, id-free deletion, and unknown pending or missing', () => {
  expect(contributionFromPublicIdentity(live)).toEqual({ id: live.id, kind: 'actor', displayName: 'Ada' });
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
