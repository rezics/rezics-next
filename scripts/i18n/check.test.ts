import { expect, test } from 'bun:test';
import { hasPlaceholderMismatch, inspectMessagePlaceholders, unlistedWebFeatures } from './check.ts';

test('reports placeholder syntax that would reach the rendered message literally', () => {
  const message = inspectMessagePlaceholders("'{{count}} members'");
  expect(message.placeholders).toEqual(['count']);
  expect(message.placeholderErrors).toContain('contains a placeholder outside insert()');

  const plural = inspectMessagePlaceholders("plural({ other: '{{count}} members' }, { count: asValue(number()) })");
  expect(plural.placeholderErrors).toContain('contains a placeholder outside insert()');
});

test('accepts inserted placeholders and rejects dropped or renamed names', () => {
  const english = inspectMessagePlaceholders("insert('{{count}} members', { count: String })");
  const dropped = inspectMessagePlaceholders("insert('Members', { count: String })");
  const renamed = inspectMessagePlaceholders("insert('{{total}} members', { total: String })");
  expect(english.placeholderErrors).toEqual([]);
  expect(hasPlaceholderMismatch(english, dropped)).toBe(true);
  expect(hasPlaceholderMismatch(english, renamed)).toBe(true);
});

test('keeps discovered web features in the checker list', () => {
  expect(unlistedWebFeatures(['auth', 'library', 'profile'], ['auth'])).toEqual(['library', 'profile']);
});
