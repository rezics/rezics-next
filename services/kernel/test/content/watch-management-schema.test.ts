import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { WatchManagementPageSchema } from '../../src/content/schemas.ts';

const identity = {
  id: '00000000-0000-7000-8000-000000000001',
  kind: 'board',
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
};
const available = { ...identity, state: 'available', resourceId: identity.id, title: null };
const unavailable = { ...identity, state: 'unavailable' };

test('watch management pages stay closed, bounded, and explicit about concealed targets', () => {
  expect(Value.Check(WatchManagementPageSchema, { items: [available, unavailable], next: null })).toBe(true);
  expect(Value.Check(WatchManagementPageSchema, { items: [], next: null })).toBe(true);
  expect(Value.Check(WatchManagementPageSchema, { items: [{ ...available, private: true }], next: null })).toBe(false);
  expect(Value.Check(WatchManagementPageSchema, { items: Array(21).fill(available), next: null })).toBe(false);
  expect(Value.Check(WatchManagementPageSchema, { items: [], next: 'x'.repeat(4097) })).toBe(false);
});
