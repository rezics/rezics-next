import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument, withDocumentIds } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';
import { projectPostReading } from '../src/threads/post-reference-list';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const document = parseDocument({
  version: 'rezics-document-v1', profile: 'blocks',
  doc: withDocumentIds({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Before ' },
    { type: 'mention', attrs: { accountId: id } },
    { type: 'mention', attrs: { accountId: id }, marks: [{ type: 'spoiler' }] },
    { type: 'text', text: ' after', marks: [{ type: 'link', attrs: { href: 'https://example.org/' } }] },
    { type: 'mention', attrs: { accountId: id } },
  ] }] }),
});
const identities = { mentions: { [id]: { handle: 'current_handle' } }, locale: 'en' };

test('disclosed identity occurrences share the existing reference return index without disturbing link positions', () => {
  const projection = projectPostReading(document, new Set(), identities);
  expect(projection.references.entries.map(({ position }) => position)).toEqual([-1, 0, -3]);
  expect(projection.references.entries[0]).toMatchObject({ label: '@current_handle', href: '/en/@current_handle' });
  expect(projectPostReading(document, new Set([0]), identities).references.entries.map(({ position }) => position))
    .toEqual([-1, -2, 0, -3]);
  expect(projectPostReading(document).references.entries.map(({ position }) => position)).toEqual([0]);
  const attributes: number[] = [];
  const html = renderToStaticMarkup(<DocumentBody document={document} mentions={identities.mentions}
    mentionAttributes={(occurrence) => { attributes.push(occurrence); return { id: `mention-${occurrence}` }; }} />);
  expect(attributes).toEqual([0, 1, 2]);
  expect(html).toContain('id="mention-2"');
  expect(html).toContain('Before ');
  expect(html).toContain(' after');
  const fallback = renderToStaticMarkup(<DocumentBody document={document} mentions={{}} />);
  expect(fallback).not.toContain('/en/@');
  expect(fallback).not.toContain('current_handle');
});
