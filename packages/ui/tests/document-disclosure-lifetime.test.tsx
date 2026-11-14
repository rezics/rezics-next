import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
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

test('footnote disclosures belong to their reader and retire on document or visit replacement', async () => {
  const webTests = join(import.meta.dir, '../../../apps/web/tests');
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', webTests))));
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const documentWithNote = (body: string): DocumentSnapshot =>
    parseDocument({
      version: 'rezics-document-v1',
      profile: 'text',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'reading' },
            content: [
              { type: 'text', text: 'Read ' },
              { type: 'footnoteReference', attrs: { label: 'source' } },
            ],
          },
          {
            type: 'footnoteDefinition',
            attrs: { id: 'definition', label: 'source' },
            content: [{ type: 'paragraph', attrs: { id: 'note' }, content: [{ type: 'text', text: body }] }],
          },
        ],
      },
    });
  const first = parseDocument(JSON.parse(serializeDocument(documentWithNote('First supplied source'))));
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const view = (document: DocumentSnapshot, visitKey: string) =>
    createElement(
      'div',
      null,
      createElement(DocumentBody, { document, visitKey }),
      createElement(DocumentBody, { document, visitKey }),
    );
  const open = async (details: HTMLDetailsElement) =>
    act(async () => {
      details.open = true;
      details.dispatchEvent(new window.Event('toggle'));
    });

  try {
    await act(async () => root.render(view(first, 'visit-a')));
    let details = [...host.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(details).toHaveLength(2);
    const summaries = [...host.querySelectorAll('summary')];
    const references = [...host.querySelectorAll('a[aria-label^="Go to footnote"]')];
    expect(summaries[0]!.id).not.toBe(summaries[1]!.id);
    expect(references[0]!.getAttribute('href')).toBe(`#${summaries[0]!.id}`);
    expect(references[1]!.getAttribute('href')).toBe(`#${summaries[1]!.id}`);
    await open(details[0]!);
    details = [...host.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(details[0]!.open).toBe(true);
    expect(details[1]!.open).toBe(false);
    expect(host.textContent).toContain('First supplied source');

    await act(async () => root.render(view(documentWithNote('Changed supplied source'), 'visit-a')));
    details = [...host.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(details.every((item) => !item.open)).toBe(true);
    expect(host.textContent).not.toContain('Changed supplied source');

    await open(details[0]!);
    const equalBytes = parseDocument(JSON.parse(serializeDocument(first)));
    await act(async () => root.render(view(equalBytes, 'visit-b')));
    details = [...host.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(details.every((item) => !item.open)).toBe(true);
    expect(host.textContent).not.toContain('First supplied source');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
