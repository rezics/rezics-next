import { describe, expect, test } from 'bun:test';
import { LABELS_CURSOR_MAX_LENGTH, LABELS_PREFIX_MAX_SCALARS, parseLabelsAddress } from '../src/library/labels-address';

describe('Labels saved addresses', () => {
  test('preserves a valid Unicode prefix exactly and counts Unicode scalar values', () => {
    const query = 'e\u0301 📚';
    expect(parseLabelsAddress({ query, cursor: 'next-token' })).toEqual({
      valid: true,
      query,
      cursor: 'next-token',
    });
    expect(parseLabelsAddress({ query: '😀'.repeat(LABELS_PREFIX_MAX_SCALARS) }).valid).toBe(true);
    expect(parseLabelsAddress({ query: '😀'.repeat(LABELS_PREFIX_MAX_SCALARS + 1) })).toMatchObject({
      valid: false,
      issue: 'prefix',
    });
    expect(parseLabelsAddress({ query: '\ud800' })).toMatchObject({ valid: false, issue: 'prefix' });
  });

  test('keeps the exact valid prefix for cursor correction and rejects malformed selectors', () => {
    const query = '字 e\u0301';
    expect(parseLabelsAddress({ query, cursor: 'x'.repeat(LABELS_CURSOR_MAX_LENGTH + 1) })).toMatchObject({
      valid: false,
      issue: 'cursor',
      query,
    });
    expect(parseLabelsAddress({ query, cursor: { bad: true } })).toMatchObject({
      valid: false,
      issue: 'cursor',
      query,
    });
    expect(parseLabelsAddress({ query: ['not', 'a', 'prefix'] })).toMatchObject({
      valid: false,
      issue: 'prefix',
    });
    expect(parseLabelsAddress({ cursor: '' })).toEqual({ valid: true, cursor: null, query: null });
  });
});
