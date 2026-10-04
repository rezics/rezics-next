import { expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { authoredDocumentBody, retainedDocumentBody, authoredPostNotes, retainedPostNotes } from '../src/document-body.ts';
import { resolveParagraphSelector } from '../src/comments.ts';

test('Post notes keep two separate document bodies, including absent and empty parts', () => {
  const before = fromPlainText('作者的话');
  const notes = authoredPostNotes({ before: { document: before }, after: { body: '' } });
  expect(notes).toEqual({ before: { body: '作者的话', document: before }, after: { body: '' } });
  expect(retainedPostNotes(notes)).toEqual(notes);
  expect(authoredPostNotes(undefined)).toBeUndefined();
  expect(retainedPostNotes(undefined)).toBeUndefined();
  expect(authoredPostNotes({})).toEqual({});
  expect(authoredPostNotes({ after: { body: 'Translator note' } })).toEqual({ after: { body: 'Translator note' } });
  expect(retainedDocumentBody({ body: 'Chapter text', notes })).toEqual({ body: 'Chapter text' });
  expect(() => retainedPostNotes({ before: { body: 'Different', document: before } })).toThrow('projection differs');
});

test('Post note bounds count UTF-16 units for plain and structured text', () => {
  for (const body of ['字'.repeat(8192), '😀'.repeat(4096)]) {
    expect(authoredPostNotes({ before: { body }, after: { document: fromPlainText(body) } })?.before?.body).toBe(body);
    expect(() => authoredPostNotes({ before: { body: body + 'a' } })).toThrow();
    expect(() => authoredPostNotes({ after: { document: fromPlainText(body + 'a') } })).toThrow();
    expect(() => retainedPostNotes({ after: { body: body + 'a' } })).toThrow();
  }
  for (const value of [null, [], { extra: {} }, { before: null }, { after: { body: 'a', notes: {} } },
    { before: { body: '\0' } }, { after: { body: '\uD800' } }]) {
    expect(() => authoredPostNotes(value as never)).toThrow();
    expect(() => retainedPostNotes(value)).toThrow();
  }
  expect(() => authoredPostNotes({ before: { body: 'a', document: fromPlainText('a') } })).toThrow();
});

test('retained Unicode Content is checked against its revision bound, while ingress keeps its own text budget', () => {
  const body = '字'.repeat(65_536);
  expect(() => authoredDocumentBody({ body })).toThrow('invalid text body');
  expect(authoredDocumentBody({ body }, 3 * 65_536)).toEqual({ body });
  expect(retainedDocumentBody({ body })).toEqual({ body });
  const document = fromPlainText(body);
  expect(retainedDocumentBody({ body, document })).toMatchObject({ body, document });
  expect(() => retainedDocumentBody({ body: 'a'.repeat(1_000_001) })).toThrow('invalid text body');
  expect(() => retainedDocumentBody({ body: 'different', document })).toThrow('document text projection differs');
});

test('structured bodies retain formatting and derive paragraph selectors from base text', () => {
  // Normalized snapshots are frozen; a fixture edits its own copy.
  const document = structuredClone(fromPlainText('Opening\n漢字\nClosing'));
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
  const document = structuredClone(fromPlainText('😀'.repeat(40) + '\nTarget\nAfter'));
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
  const document = structuredClone(fromPlainText('', 'blocks'));
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
