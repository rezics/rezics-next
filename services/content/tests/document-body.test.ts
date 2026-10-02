import { expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { authoredDocumentBody, retainedDocumentBody } from '../src/document-body.ts';
import { resolveParagraphSelector } from '../src/comments.ts';

test('structured bodies retain formatting and derive paragraph selectors from base text', () => {
  const document = fromPlainText('Opening\n漢字\nClosing');
  document.doc.content![1]!.content = [
    {
      type: 'ruby',
      attrs: { rt: 'ㄏㄢˋ', position: 'inter-character' },
      content: [{ type: 'text', text: '漢' }],
    },
    { type: 'text', text: '字', marks: [{ type: 'bold' }] },
  ];
  const retained = authoredDocumentBody({ document });
  expect(retained.body).toBe('Opening\n漢字\nClosing');
  expect(serializeDocument(retained.document!)).toBe(serializeDocument(document));
  expect(resolveParagraphSelector(retained.body, '漢字')).toEqual({
    type: 'TextQuoteSelector',
    exact: '漢字',
    prefix: 'Opening\n',
    suffix: '\nClosing',
  });
  expect(retainedDocumentBody({ ...retained })).toEqual(retained);
  expect(() => retainedDocumentBody({ ...retained, body: 'different' })).toThrow();
  expect(() => authoredDocumentBody({ document, body: retained.body })).toThrow();
});

test('a paragraph with a hard break retains one exact selector and Unicode context', () => {
  const document = fromPlainText('😀'.repeat(40) + '\nTarget\nAfter');
  document.doc.content![1]!.content!.push(
    { type: 'hardBreak' },
    { type: 'text', text: 'second line' },
  );
  const retained = authoredDocumentBody({ document });
  const selector = resolveParagraphSelector(
    retained.body,
    'Target\nsecond line',
    retained.document,
  );
  expect(selector.exact).toBe('Target\nsecond line');
  expect(selector.prefix).toBe('😀'.repeat(31) + '\n');
});

test('unknown components preserve external specification payload and fallback text', () => {
  const document = fromPlainText('', 'blocks');
  document.doc.content!.push({
    type: 'extensionBlock',
    attrs: {
      id: 'map',
      definition: 'https://example.org/geojson',
      version: '1',
      fallback: 'Place map',
      payload: { type: 'Point', coordinates: [121.5, 25] },
    },
  });
  const retained = authoredDocumentBody({ document });
  expect(retained.body).toBe('\nPlace map');
  expect(retained.document!.doc.content!.at(-1)!.attrs!.payload).toEqual({
    type: 'Point',
    coordinates: [121.5, 25],
  });
});
