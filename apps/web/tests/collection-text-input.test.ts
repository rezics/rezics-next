import { expect, test } from 'bun:test';
import { collectionTextIssue } from '../src/library/collection-text-input';

test('native Collection scalar bounds retain exact whitespace, supplementary characters and optional values', () => {
  for (const [field, limit] of [['title', 200], ['description', 2000], ['note', 1000]] as const) {
    const exact = ' \n' + '😀'.repeat(limit - 2);
    expect(collectionTextIssue(field, exact)).toBeNull();
    expect(collectionTextIssue(field, exact + 'x')).toBe('limit');
    expect(collectionTextIssue(field, 'a\0b')).toBe('nul');
    expect(collectionTextIssue(field, ' \n')).toBeNull();
    expect(collectionTextIssue(field, '')).toBe(field === 'title' ? 'required' : null);
    expect(collectionTextIssue(field, null)).toBe(field === 'title' ? 'required' : null);
  }
});
