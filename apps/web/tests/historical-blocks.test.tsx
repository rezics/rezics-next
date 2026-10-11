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
    '<span class=\"document-component\" data-unknown-node="hostileAlign" role="note"></span>',
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
  assertHistoricalAttributes();
  assertValidAttributes();
});

function storedDocument(nodes: DocumentNode[]): DocumentSnapshot {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before hostile attributes.' }] },
        ...nodes,
        { type: 'paragraph', content: [{ type: 'text', text: 'After hostile attributes.' }] },
      ],
    },
  };
}

function attributedNode(
  type: string,
  attrs: Record<string, unknown>,
  content: DocumentNode[] = [{ type: 'text', text: markupText }],
): DocumentNode {
  return { type, attrs, content } as DocumentNode;
}

function wrapNode(node: DocumentNode): DocumentNode {
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    return { type: 'table', content: [{ type: 'tableRow', content: [node] }] };
  }
  if (node.type === 'taskItem') return { type: 'taskList', content: [node] };
  if (node.type === 'ruby' || node.type === 'extensionInline') {
    return { type: 'paragraph', content: [node] };
  }
  return node;
}

// Every attribute read by the shared reader, including metadata used by nested image components.
const nodeAttributeCases: [string, string, Record<string, unknown>?][] = [
  ...['id', 'lang', 'dir', 'textAlign'].map((attr): [string, string] => ['paragraph', attr]),
  ['heading', 'level', { id: 'bad-heading', textAlign: 'center', lang: 'en' }],
  ['heading', 'textAlign', { level: 2 }],
  ['codeBlock', 'language'],
  ['orderedList', 'start'],
  ['taskItem', 'checked'],
  ...['tableCell', 'tableHeader'].flatMap((type) =>
    ['align', 'colspan', 'rowspan', 'colwidth'].map((attr): [string, string] => [type, attr]),
  ),
  ['ruby', 'rt'],
  ['ruby', 'position', { rt: 'reading' }],
  ...['src', 'alt', 'title', 'width', 'height', 'representationId', 'mediaUseId', 'conceal'].map(
    (attr): [string, string, Record<string, unknown>] => ['image', attr, { src: '/cover.png' }],
  ),
  ...['src', 'kind', 'caption'].map((attr): [string, string, Record<string, unknown>] => [
    'media',
    attr,
    { src: '/clip.mp4', kind: 'video' },
  ]),
  ...['extensionInline', 'extensionBlock'].flatMap((type) =>
    ['definition', 'fallback'].map((attr): [string, string] => [type, attr]),
  ),
];
const markAttributeCases: [string, string, Record<string, unknown>?][] = [
  ['link', 'href'],
  ['link', 'title', { href: '/safe' }],
  ['language', 'lang'],
  ['language', 'dir'],
  ['textStyle', 'color'],
  ['textStyle', 'backgroundColor'],
  ...['fill', 'shape', 'position', 'color'].map((attr): [string, string] => ['textEmphasis', attr]),
];

function assertSafeAttributes(document: DocumentSnapshot): string {
  const original = structuredClone(document);
  let html = '';
  expect(() => {
    html = renderToStaticMarkup(createElement(DocumentBody, { document }));
  }).not.toThrow();
  expect(html).toContain('<p>Before hostile attributes.</p>');
  expect(html).toContain('<p>After hostile attributes.</p>');
  expect(html).not.toMatch(/<script\b|<[a-z][^>]*\sonerror\s*=|href\s*=\s*["']javascript:/i);
  expect(html).not.toContain('[object Object]');
  // An HTML parser closes a paragraph at a div, so a placeholder inside a paragraph must not be one.
  expect(html).not.toMatch(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*<div\b/);
  expect(html).not.toContain('nested-hostile-value');
  expect(document).toEqual(original);
  return html;
}

function assertHistoricalAttributes() {
  // Run each attribute separately so a broken node cannot hide a neighbouring failure.
  const hostileValues: unknown[] = [
    { toString: null },
    ['nested-hostile-value'],
    { nested: { value: 'nested-hostile-value' } },
  ];
  for (const [type, attr, defaults] of nodeAttributeCases) {
    for (const value of hostileValues) {
      const html = assertSafeAttributes(
        storedDocument([wrapNode(attributedNode(type, { ...defaults, [attr]: value }))]),
      );
      if (
        (type === 'heading' && attr === 'level') ||
        (type === 'image' && attr === 'src') ||
        (type === 'ruby' && attr === 'rt')
      ) {
        expect(html.match(new RegExp(`data-malformed-node="${type}"`, 'g'))).toHaveLength(1);
        expect(html).toContain(
          `<span class="document-component" data-malformed-node="${type}" role="note"></span>`,
        );
      }
      if (attr === 'checked') expect(html).toContain('aria-checked="false"');
      if (attr === 'conceal') expect(html).toContain('<img');
      if (attr === 'width' || attr === 'height') expect(html).not.toContain(` ${attr}=`);
    }
  }
  for (const [type, attr, defaults] of markAttributeCases) {
    for (const value of hostileValues) {
      const html = assertSafeAttributes(
        storedDocument([
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: markupText,
                marks: [
                  { type, attrs: { ...defaults, [attr]: value } } as NonNullable<
                    DocumentNode['marks']
                  >[number],
                ],
              },
            ],
          },
        ]),
      );
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  }

  // Arrays are expected only for column widths; their elements need the same guards.
  for (const type of ['tableCell', 'tableHeader']) {
    for (const value of hostileValues) {
      const html = assertSafeAttributes(
        storedDocument([wrapNode(attributedNode(type, { colwidth: [20, value] }))]),
      );
      expect(html).not.toContain('width:');
    }
  }

  for (const value of [
    null,
    true,
    '',
    'not-a-number',
    'Infinity',
    Infinity,
    NaN,
    0,
    -1,
    2.5,
    '7',
  ]) {
    const html = assertSafeAttributes(
      storedDocument([attributedNode('heading', { level: value })]),
    );
    expect(html).toContain('data-malformed-node="heading"');
  }
  for (const value of [Infinity, NaN, 'Infinity', 0, -1]) {
    const html = assertSafeAttributes(
      storedDocument([
        attributedNode('image', { src: '/cover.png', width: value, height: value }),
        wrapNode(
          attributedNode('tableCell', { colwidth: [20, value], colspan: value, rowspan: value }),
        ),
        attributedNode('orderedList', { start: value }),
      ]),
    );
    expect(html).not.toMatch(/ (?:width|height|colSpan|rowSpan|start)=|width:/);
  }

  for (const value of [null, 'true', 'false', 1, '1']) {
    const html = assertSafeAttributes(
      storedDocument([wrapNode(attributedNode('taskItem', { checked: value }))]),
    );
    expect(html).toContain('aria-checked="false"');
  }
  for (const value of [2.5, '2.5', true, '']) {
    const html = assertSafeAttributes(
      storedDocument([
        wrapNode(
          attributedNode('tableCell', { colspan: value, rowspan: value, colwidth: [value] }),
        ),
        attributedNode('orderedList', { start: value }),
      ]),
    );
    expect(html).not.toMatch(/ (?:colSpan|rowSpan|start)=|width:/);
  }

  // Strings can be hostile too: reject URLs, choices and CSS declaration escapes.
  const html = assertSafeAttributes(
    storedDocument([
      attributedNode('heading', { level: 2, textAlign: 'bogus' }),
      attributedNode('image', { src: 'javascript:alert(1)' }),
      attributedNode('media', { src: 'javascript:alert(1)', caption: markupText }),
      attributedNode('ruby', { rt: markupText, position: 'bogus' }),
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: markupText,
            marks: [
              { type: 'link', attrs: { href: 'javascript:alert(1)' } },
              {
                type: 'textStyle',
                attrs: { color: 'red;display:none', backgroundColor: 'red;display:none' },
              },
              {
                type: 'textEmphasis',
                attrs: {
                  fill: 'bogus',
                  shape: 'bogus',
                  position: 'bogus',
                  color: 'red;display:none',
                },
              },
            ],
          },
        ],
      },
    ]),
  );
  expect(html).not.toMatch(/bogus|javascript:|display:none/);
}

function assertValidAttributes() {
  const html = assertSafeAttributes(
    storedDocument([
      attributedNode(
        'heading',
        { id: 'title', level: 2, textAlign: 'center', lang: 'ja', dir: 'rtl' },
        [{ type: 'text', text: 'Title' }],
      ),
      attributedNode('heading', {}, [{ type: 'text', text: 'Default heading' }]),
      attributedNode('orderedList', { start: 3 }, [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }],
        },
      ]),
      wrapNode(attributedNode('taskItem', { checked: true })),
      wrapNode(
        attributedNode('tableHeader', {
          align: 'right',
          colwidth: [40, 60],
          colspan: 2,
          rowspan: 3,
        }),
      ),
      attributedNode('codeBlock', { language: 'typescript' }),
      attributedNode('image', {
        src: '/cover.png',
        alt: 'Cover',
        title: 'Book',
        width: 120,
        height: 80,
      }),
      attributedNode('media', { src: '/clip.mp4', kind: 'video', caption: 'Clip' }),
      wrapNode(attributedNode('ruby', { rt: 'reading', position: 'under' })),
      attributedNode('extensionBlock', { definition: 'work-reference', fallback: 'Reference' }),
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Styled',
            marks: [
              { type: 'language', attrs: { lang: 'ja', dir: 'ltr' } },
              { type: 'link', attrs: { href: 'https://example.com/book', title: 'Read' } },
              { type: 'textStyle', attrs: { color: 'red', backgroundColor: '#fff' } },
              {
                type: 'textEmphasis',
                attrs: { fill: 'open', shape: 'sesame', position: 'under', color: 'blue' },
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Default emphasis', marks: [{ type: 'textEmphasis' }] }],
      },
    ]),
  );
  expect(html).toContain(
    '<h2 data-block-id="title" lang="ja" dir="rtl" style="text-align:center">Title</h2>',
  );
  expect(html).toContain('<h6>Default heading</h6>');
  expect(html).toContain('<ol start="3">');
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain(
    '<th style="text-align:right;width:100px" colSpan="2" rowSpan="3" scope="col">',
  );
  expect(html).toContain('<code data-language="typescript">');
  expect(html).toMatch(
    /<img[^>]*title="Book"[^>]*width="120"[^>]*height="80"[^>]*src="\/cover.png"[^>]*alt="Cover"/,
  );
  expect(html).toContain(
    '<video controls="" src="/clip.mp4" preload="none" aria-label="Clip"></video><figcaption>Clip</figcaption>',
  );
  expect(html).toContain('<ruby style="ruby-position:under">');
  expect(html).toContain('<rt>reading</rt>');
  expect(html).toContain('data-document-component="work-reference">Reference</div>');
  expect(html).toContain('<span lang="ja" dir="ltr">Styled</span>');
  expect(html).toContain(
    '<a href="https://example.com/book" title="Read" rel="noopener noreferrer">',
  );
  expect(html).toContain('style="color:red;background-color:#fff"');
  expect(html).toContain(
    'style="text-emphasis-style:open sesame;text-emphasis-position:under right;text-emphasis-color:blue"',
  );
  expect(html).toContain(
    'style="text-emphasis-style:filled dot;text-emphasis-position:over right">Default emphasis</span>',
  );

  const numericStrings = assertSafeAttributes(
    storedDocument([
      attributedNode('heading', { level: '2' }),
      attributedNode('orderedList', { start: '3' }),
      wrapNode(attributedNode('tableCell', { colspan: '2', rowspan: '3', colwidth: ['40', '60'] })),
      attributedNode('image', { src: '/cover.png', width: '120', height: '80' }),
    ]),
  );
  expect(numericStrings).toContain('<h2>');
  expect(numericStrings).toContain('<ol start="3">');
  expect(numericStrings).toContain('<td style="width:100px" colSpan="2" rowSpan="3">');
  expect(numericStrings).toContain('width="120" height="80"');
}
