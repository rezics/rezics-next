import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';

const markupText = '<script>alert(1)</script><img onerror=alert(1) src=x>';

function historicalDocument(): DocumentSnapshot {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Before the historical blocks.' }],
        },
        {
          type: 'futureCallout',
          attrs: {
            id: 'legacy-callout',
            tone: 'alert',
            html: '<img onerror=alert(1) src=x>',
          },
          content: [{ type: 'text', text: 'Nested callout body' }],
        },
        {
          type: 'image',
          attrs: { id: 'broken-image', alt: 'Cover without a source' },
        },
        {
          type: 'heading',
          attrs: { id: 'bad-heading', level: 9 },
          content: [{ type: 'text', text: 'Level outside the schema' }],
        },
        {
          type: 'heading',
          attrs: { id: 'h' },
          content: [{ type: 'text', text: 'Title without a level' }],
        },
        {
          type: 'hostileAlign',
          // Hostile historical attrs must not reach the DOM style tree via the placeholder.
          attrs: { textAlign: { toString: null } } as unknown as NonNullable<DocumentNode['attrs']>,
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'scripted link',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', title: 'Nope' } }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: markupText }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'After the historical blocks.' }],
        },
      ],
    },
  };
}

test('VIEW04: malformed and unknown historical blocks render as isolated placeholders', () => {
  const document = historicalDocument();
  const before = structuredClone(document);

  let html = '';
  expect(() => {
    html = renderToStaticMarkup(createElement(DocumentBody, { document }));
  }).not.toThrow();

  expect(html).toContain('Before the historical blocks.');
  expect(html).toContain('After the historical blocks.');

  const unknown = html.match(/data-unknown-node="futureCallout"/g) ?? [];
  expect(unknown).toHaveLength(1);
  expect(html).not.toContain('Nested callout body');
  expect(html).not.toContain('data-unknown-node="futureCallout">Nested');

  const malformedImage = html.match(/data-malformed-node="image"/g) ?? [];
  expect(malformedImage).toHaveLength(1);
  expect(html).not.toMatch(/<img\b/i);

  const malformedHeading = html.match(/data-malformed-node="heading"/g) ?? [];
  expect(malformedHeading).toHaveLength(1);
  expect(html).not.toContain('Level outside the schema');

  expect(html).toContain('<h6');
  expect(html).toContain('Title without a level');
  expect(html).toMatch(/<h6[^>]*>Title without a level<\/h6>/);

  const hostile = html.match(/data-unknown-node="hostileAlign"/g) ?? [];
  expect(hostile).toHaveLength(1);
  expect(html).toContain(
    '<div class="document-component" data-unknown-node="hostileAlign" role="note"></div>',
  );

  expect(html).toContain('scripted link');
  expect(html).not.toMatch(/href\s*=\s*["']javascript:/i);
  expect(html).not.toContain('javascript:');

  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&lt;img onerror=alert(1) src=x&gt;');
  expect(html).not.toMatch(/<script\b/i);
  // Escaped text may mention onerror; it must not appear as a real attribute.
  expect(html).not.toMatch(/<[a-z][^>]*\sonerror\s*=/i);

  expect(document).toEqual(before);
});
