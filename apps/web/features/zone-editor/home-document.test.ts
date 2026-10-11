import { fromPlainText, type DocumentNode } from '@rezics/document';
import { describe, expect, test } from 'vitest';
import { zoneHomeDocument, zoneHomeProse, type ZoneHomePage } from './home-document.tsx';

const definition = 'https://rezics.com/definition/showcase-block-v1';
const showcase: DocumentNode = { type: 'extensionBlock', attrs: {
  id: 'showcase', definition, version: '2', payload: {}, fallback: 'Showcase fallback',
} };
const resolved: ZoneHomePage['blocks'][number] = {
  id: 'showcase', definition, version: '2', fallback: 'Showcase fallback',
  status: 'resolved', kind: 'showcase', showcase: 'showcase',
};

describe('Zone home document rendering', () => {
  test('a Showcase resolved by Main renders through modules, while prose and opaque blocks retain their order', () => {
    const document = fromPlainText('Before the Showcase', 'blocks');
    const opaque: DocumentNode = { ...showcase, attrs: { ...showcase.attrs, id: 'future',
      definition: 'https://example.org/future', fallback: 'Future component' } };
    document.doc.content!.push(showcase, opaque, ...fromPlainText('After the Showcase', 'blocks').doc.content!);
    const original = structuredClone(document);
    const body = zoneHomeProse(document, [resolved, {
      id: 'future', definition: 'https://example.org/future', version: '2', fallback: 'Future component',
      status: 'placeholder', reason: 'unknown_definition',
    }]);

    expect(body.doc.content).toEqual([document.doc.content![0], opaque, document.doc.content![3]]);
    expect(document).toEqual(original);
    expect(zoneHomeDocument({ document })).toEqual(original);
  });

  test('a nested resolved Showcase is removed without discarding its surrounding document structure', () => {
    const document = fromPlainText('Kept paragraph', 'blocks');
    document.doc.content!.push({ type: 'blockquote', attrs: { id: 'quote' }, content: [showcase,
      ...fromPlainText('Kept quotation', 'blocks').doc.content!] });
    const body = zoneHomeProse(document, [resolved]);
    expect(body.doc.content![1]).toEqual({ ...document.doc.content![1],
      content: document.doc.content![1]!.content!.slice(1) });
  });

  test('unresolved, invalid and future Showcase versions keep the original fallback', () => {
    const document = fromPlainText('Kept', 'blocks');
    document.doc.content!.push(showcase);
    expect(zoneHomeProse(document, [{ ...resolved, status: 'placeholder', reason: 'invalid_payload' }])).toBe(document);
    expect(zoneHomeProse(document, [])).toBe(document);
  });
});
