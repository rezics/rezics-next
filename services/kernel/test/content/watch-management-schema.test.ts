import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { WatchManagementPageSchema } from '../../src/content/schemas.ts';

const identity = {
  id: '00000000-0000-7000-8000-000000000001',
  kind: 'board',
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
};
const command = { watchId: identity.id, kind: identity.kind, expectedRevision: identity.revision };
const available = { ...identity, state: 'available', resourceId: identity.id, title: null, command };
const unavailable = { ...identity, state: 'unavailable', command };
const page = { viewer: { state: 'current', accountId: identity.id }, actions: { remove: 'available' } };

test('watch management pages stay closed, bounded, and explicit about concealed targets', () => {
  expect(Value.Check(WatchManagementPageSchema, { ...page, items: [available, unavailable], next: null })).toBe(true);
  expect(Value.Check(WatchManagementPageSchema, { ...page, items: [], next: null })).toBe(true);
  expect(Value.Check(WatchManagementPageSchema, { items: [available, unavailable], next: null })).toBe(false);
  expect(
    Value.Check(WatchManagementPageSchema, { ...page, items: [{ ...available, private: true }], next: null }),
  ).toBe(false);
  expect(Value.Check(WatchManagementPageSchema, { ...page, items: Array(21).fill(available), next: null })).toBe(false);
  expect(Value.Check(WatchManagementPageSchema, { ...page, items: [], next: 'x'.repeat(4097) })).toBe(false);
  expect(
    Value.Check(WatchManagementPageSchema, {
      ...page,
      items: [{ ...identity, state: 'unavailable', resourceId: identity.id, command }],
      next: null,
    }),
  ).toBe(false);
  expect(
    Value.Check(WatchManagementPageSchema, { ...page, actions: { remove: 'not-applicable' }, items: [], next: null }),
  ).toBe(false);
});
