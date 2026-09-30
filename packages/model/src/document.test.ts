import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { Value } from 'typebox/value';
import { checkDocument, documentVersion, DocumentSnapshotSchema, inspectDocument, parseDocument,
  type DocumentBlock, type DocumentSnapshot } from './document.ts';

const digest = 'a'.repeat(64);
const text = (value: string) => ({ type: 'text' as const, text: value, styles: {} });
const paragraph = (id: string): DocumentBlock => ({ id, type: 'paragraph', content: [text('same paragraph')] });
const snapshot = (blocks: DocumentBlock[]): DocumentSnapshot => ({ version: documentVersion, blocks });
const seed = Number(process.env.REZICS_QA_SEED ?? '20260930');

test('G-510: empty documents are valid without a placeholder block', () => {
  const empty = snapshot([]);
  expect(Value.Check(DocumentSnapshotSchema, empty)).toBe(true);
  expect(parseDocument(empty)).toBe(empty);
  expect(inspectDocument(empty)).toEqual({ snapshot: empty, unknownBlocks: [] });
});

test('G-510: mixed BlockNote-shaped content, ruby, emphasis, language and table cells round-trip verbatim', () => {
  const mixed = snapshot([
    { id: 'heading', type: 'heading', props: { level: 2, textAlignment: 'left' },
      content: [{ ...text('日本語'), styles: { bold: true, textColor: 'blue' }, lang: 'ja-Jpan',
        marks: [{ type: 'emphasis', style: 'sesame', position: 'over' }] }], children: [] },
    { id: 'paragraph', type: 'paragraph', content: [
      { type: 'ruby', content: [{ ...text('漢字'), lang: 'ja' }], annotation: [text('かんじ')] },
      { type: 'link', href: '/work', content: [{ ...text('中文'), lang: 'zh-Hans' }] },
      { type: 'futureInline', props: { formula: 'x+y' }, opaque: [null, { extension: true }] },
    ], children: [paragraph('nested')] },
    { id: 'table', type: 'table', content: { type: 'tableContent', columnWidths: [null, 120],
      headerRows: 1, headerCols: 0, rows: [{ cells: [
        { id: 'cell-a', type: 'tableCell', props: { colspan: 2 }, content: [text('A')] },
        { id: 'cell-b', type: 'tableCell', content: [] },
      ] }] } },
    { id: 'unknown', type: 'vendor/interactive-v2', props: { deep: { decimal: 1.25 } },
      content: { raw: ['<script>data only</script>', null, false] },
      extra: { value: '  exact spacing\n字  ', order: [3, 2, 1] }, children: [paragraph('future-child')] },
  ]);
  const bytes = JSON.stringify(mixed);
  const decoded: unknown = JSON.parse(bytes);
  const result = inspectDocument(decoded);
  expect(result.snapshot === decoded).toBe(true);
  expect(JSON.stringify(result.snapshot)).toBe(bytes);
  expect(result.unknownBlocks).toEqual([{ id: 'unknown', type: 'vendor/interactive-v2' }]);
  expect(Value.Check(DocumentSnapshotSchema, decoded)).toBe(true);
});

test('G-510: IDs form one namespace across every block, child and table cell', () => {
  const cell = { id: 'shared', type: 'tableCell', content: [] };
  const table: DocumentBlock = { id: 'table', type: 'table', content: {
    type: 'tableContent', rows: [{ cells: [cell] }],
  } };
  for (const invalid of [
    snapshot([paragraph('shared'), paragraph('shared')]),
    snapshot([{ ...paragraph('shared'), children: [paragraph('shared')] }]),
    snapshot([paragraph('shared'), table]),
    snapshot([{ ...table, id: 'shared' }]),
    snapshot([{ ...table, content: { type: 'tableContent', rows: [{ cells: [cell] }, { cells: [cell] }] } }]),
    snapshot([{ id: 'future', type: 'future', children: [paragraph('shared')] }, paragraph('shared')]),
  ]) {
    expect(checkDocument(invalid)).toBe(false);
    expect(Value.Check(DocumentSnapshotSchema, invalid)).toBe(false);
    expect(() => parseDocument(invalid)).toThrow(TypeError);
  }
  // An extension's arbitrary metadata ID is not a block/cell identity.
  expect(checkDocument(snapshot([{ id: 'shared', type: 'future', props: { id: 'shared' } }]))).toBe(true);
});

test('G-510: known content cannot escape validation through an unknown-type alternative', () => {
  for (const block of [
    { id: '', type: 'paragraph' },
    { id: 'p', type: '' },
    { id: 'p', type: 'paragraph', content: 'not inline JSON' },
    { id: 'p', type: 'paragraph', content: [{ type: 'text', text: 4, styles: {} }] },
    { id: 'p', type: 'paragraph', content: [{ type: 'ruby', content: [], annotation: 'reading' }] },
    { id: 'p', type: 'paragraph', content: [{ ...text('x'), marks: [{ type: 'unknownMark' }] }] },
    { id: 'p', type: 'table', content: { type: 'tableContent', rows: [{ cells: [[]] }] } },
  ]) expect(checkDocument({ version: documentVersion, blocks: [block] })).toBe(false);
  expect(checkDocument({ version: 'rezics-blocks-v2', blocks: [] })).toBe(false);
});

test('G-510: inline lang preserves spelling as a bounded string without a second language parser', () => {
  for (const lang of ['zh-hANS', 'x-holder-private', 'not parsed here', 'a'.repeat(256)]) {
    const value = snapshot([{ id: 'p', type: 'paragraph', content: [{ ...text('x'), lang }] }]);
    expect(parseDocument(value)).toBe(value);
  }
  for (const lang of ['', 'a'.repeat(257), 3]) {
    expect(checkDocument(snapshot([{ id: 'p', type: 'paragraph', content: [{ ...text('x'), lang }] }]))).toBe(false);
    expect(checkDocument(snapshot([{ id: 'p', type: 'paragraph', content: [{ type: 'customInline', lang }] }]))).toBe(false);
  }
});

test('G-510: lineage distinguishes copy, split and merge and pins the origin snapshot digest', () => {
  for (const kind of ['copy', 'split', 'merge'] as const) {
    const origins = [{ id: 'old-a', digest }, ...(kind === 'merge' ? [{ id: 'old-b', digest }] : [])];
    const value = snapshot([{ ...paragraph('new'), lineage: { kind, origins } }]);
    expect(parseDocument(value)).toBe(value);
  }
  for (const lineage of [
    { kind: 'split', origins: [] },
    { kind: 'copy', origins: [{ id: 'a', digest }, { id: 'b', digest }] },
    { kind: 'merge', origins: [{ id: 'a', digest }] },
    { kind: 'split', origins: [{ id: 'a', digest: 'not a digest' }] },
    { kind: 'merge', origins: [{ id: 'a', digest }, { id: 'a', digest }] },
  ]) expect(checkDocument(snapshot([{ ...paragraph('new'), lineage } as DocumentBlock]))).toBe(false);
});

test('G-510: custody validation rejects values JSON serialization would silently lose or alter', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty({}, 'secret', { value: 'hidden' });
  const accessor = { get text() { return 'dynamic'; } };
  const arrayWithMetadata = Object.assign([1], { metadata: true });
  for (const payload of [undefined, NaN, Infinity, 1n, new Date(), () => 1, cycle, [1, , 3], hidden, accessor, arrayWithMetadata]) {
    expect(checkDocument(snapshot([{ id: 'x', type: 'future', payload }]))).toBe(false);
  }
});

test('G-510 property: nested mixed snapshots and arbitrary unknown JSON retain every byte and unit ID', () => {
  fc.assert(fc.property(fc.array(fc.jsonValue(), { maxLength: 20 }), payloads => {
    const blocks: DocumentBlock[] = payloads.map((payload, i) => ({
      id: `future-${i}`, type: 'future-widget', payload,
      children: [paragraph(`child-${i}`), { id: `table-${i}`, type: 'table', content: {
        type: 'tableContent', rows: [{ cells: [{ id: `cell-${i}`, type: 'tableCell', content: [text('字😀')] }] }],
      } }],
    }));
    const bytes = JSON.stringify(snapshot(blocks));
    const result = inspectDocument(JSON.parse(bytes));
    expect(JSON.stringify(result.snapshot)).toBe(bytes);
    expect(result.unknownBlocks.map(block => block.id)).toEqual(payloads.map((_, i) => `future-${i}`));
  }), { seed, numRuns: 100 });
});
