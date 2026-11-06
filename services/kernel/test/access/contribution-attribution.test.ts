import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  contributionAttribution,
  contributionDeleted,
  ContributionAttributionSchema,
} from '../../src/access/contribution-attribution.ts';

const id = '00000000-0000-8000-8000-123400000001';

test('only authoritative deletion de-identifies retained people and organizations', () => {
  for (const kind of ['actor', 'organization'] as const) {
    const live = { id, kind, state: 'active', displayName: 'Current name', handle: 'current' };
    expect(contributionAttribution(live)).toEqual({ id, kind, displayName: 'Current name' });
    expect(contributionAttribution({ ...live, state: 'suspended' })).toEqual({ id, kind, displayName: 'Current name' });
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
