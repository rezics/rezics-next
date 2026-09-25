import { expect, test } from 'bun:test';
import { ContentCommentInvalid, contentCommentIntentDigest,
  resolveParagraphSelector } from '../src/comments.ts';

test('BOOK04: a quote resolves only to one whole paragraph in its exact source', () => {
  const old = 'Opening\nAn old paragraph with a unique phrase\nClosing';
  const exact = 'An old paragraph with a unique phrase';
  expect(resolveParagraphSelector(old, exact)).toEqual({
    type: 'TextQuoteSelector', exact, prefix: 'Opening\n', suffix: '\nClosing',
  });
  expect(() => resolveParagraphSelector('Opening\nClosing', exact))
    .toThrow(ContentCommentInvalid);
  expect(() => resolveParagraphSelector(`${exact}\n${exact}`, exact))
    .toThrow(ContentCommentInvalid);
  expect(() => resolveParagraphSelector(old, 'old paragraph'))
    .toThrow(ContentCommentInvalid);
});

test('BOOK04: the admission digest binds exact revision, quote, author and comment text', () => {
  const input = { revisionId: crypto.randomUUID(),
    resourceId: `https://rezics.com/id/${crypto.randomUUID()}`,
    author: `https://rezics.com/id/${crypto.randomUUID()}`,
    exact: 'Original paragraph', body: 'My comment' };
  const digest = contentCommentIntentDigest(input);
  for (const changed of [
    { ...input, revisionId: crypto.randomUUID() },
    { ...input, exact: 'Another paragraph' },
    { ...input, author: `https://rezics.com/id/${crypto.randomUUID()}` },
    { ...input, body: 'Another comment' },
  ]) expect(contentCommentIntentDigest(changed)).not.toBe(digest);
});
