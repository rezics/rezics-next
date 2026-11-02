import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { feedAuthor, feedExcerpt } from '../../src/content/feed-summary.ts';
import type { AccountDiscoverySummary } from '../../src/search/discovery.ts';

test('Feed excerpts use disclosed native text and stop before a grapheme crosses 160 code points', () => {
  const excerpt = (text: string) => feedExcerpt({ availability: 'available', body: fromPlainText(text) });
  expect(excerpt('  First paragraph\n\nSecond <script> & text  ')).toBe('First paragraph Second <script> & text');
  expect(excerpt('a'.repeat(158) + 'e\u0301x')).toBe('a'.repeat(158) + 'e\u0301');
  expect(excerpt('a'.repeat(159) + 'e\u0301x')).toBe('a'.repeat(159));
  expect(excerpt('a'.repeat(159) + '👩‍👩‍👧‍👦x')).toBe('a'.repeat(159));
  expect(excerpt('😀'.repeat(161))).toBe('😀'.repeat(160));
  expect(excerpt(' \n ')).toBeUndefined();
  for (const availability of ['withheld', 'erased'] as const)
    expect(feedExcerpt({ availability, body: null })).toBeUndefined();
});

test('Feed identities project only the current Account summary and never synthesize identifiers', () => {
  expect(feedAuthor(null)).toBeUndefined();
  expect(feedAuthor(undefined)).toBeUndefined();
  const account: AccountDiscoverySummary = {
    id: 'hidden-id',
    accountKind: 'actor',
    displayName: 'Reader',
    handle: 'reader',
    avatar: null,
    automated: false,
    operatorId: null,
    verifiedAgent: null,
  };
  expect(feedAuthor(account)).toEqual({ displayName: 'Reader', handle: 'reader', avatar: null });
  expect(feedAuthor({ ...account, handle: null, displayName: null })).toEqual({
    displayName: null,
    handle: null,
    avatar: null,
  });
});
