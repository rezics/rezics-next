import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument, serializeDocument, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '../src/components/document-body.tsx';
import { DocumentSpoiler } from '../src/components/document-spoiler.tsx';

test('independently serialized document snapshots keep SSR semantics and standalone spoilers stay compatible', () => {
  const document: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'text',
    doc: withDocumentIds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Server rendered secret', marks: [{ type: 'spoiler' }] }],
        },
      ],
    }),
  };
  const serialized = serializeDocument(document);
  const parsed = parseDocument(JSON.parse(serialized));
  const first = renderToStaticMarkup(
    createElement(DocumentBody, { document, labels: { revealSpoiler: 'Show secret' } }),
  );
  const second = renderToStaticMarkup(
    createElement(DocumentBody, { document: parsed, labels: { revealSpoiler: 'Show secret' } }),
  );

  expect(serializeDocument(parsed)).toBe(serialized);
  expect(second).toBe(first);
  expect(first).toContain('aria-label="Show secret"');
  expect(first).toContain('aria-hidden="true"');
  expect(first).toContain('Server rendered secret');

  const standalone = renderToStaticMarkup(createElement(DocumentSpoiler, { children: 'Standalone secret' }));
  expect(standalone).toContain('<button');
  expect(standalone).toContain('aria-label="Reveal spoiler"');
  expect(standalone).toContain('Standalone secret');
  expect(standalone).toContain('aria-hidden="true"');
});

test('renderer-supported extension snapshots need no producer fallback to render', () => {
  const document: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: { type: 'doc', content: [{ type: 'extensionBlock', attrs: { definition: 'future', fallback: null } }] },
  };
  expect(() => serializeDocument(document)).toThrow();
  expect(renderToStaticMarkup(createElement(DocumentBody, { document }))).toContain(
    'data-document-component="future">Embedded component</div>',
  );
});
