import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { checkDocument, documentVersion, parseDocument, type DocumentBlock, type DocumentSnapshot } from './document.ts';
import { checkLocator, ContentCommentTargetSchema, locatorFromComment, locatorVersion,
  parseLocator, resolveBlock, type Locator } from './locator.ts';
import { Value } from 'typebox/value';

const digest = 'a'.repeat(64);
const source = { type: 'hosted' as const, revision: 'revision-1', digest };
const external = (mediaType: string) => ({ type: 'external' as const, representationSha256: digest, mediaType });
const paragraph = (id: string, text = 'Identical paragraph'): DocumentBlock => ({
  id, type: 'paragraph', content: [{ type: 'text', text, styles: {} }],
});
const snapshot = (blocks: DocumentBlock[]): DocumentSnapshot => ({ version: documentVersion, blocks });
const blockLocator = (blockId: string): Locator => ({ version: locatorVersion, source,
  selector: { type: 'BlockSelector', blockId } });
const seed = Number(process.env.REZICS_QA_SEED ?? '20260930');

test('G-510: hosted blocks and external TXT, EPUB and script locators round-trip with explicit units', () => {
  for (const value of [
    { version: locatorVersion, source, selector: { type: 'BlockSelector', blockId: 'p',
      range: { unit: 'code-point', start: 1, end: 3 } } },
    { version: locatorVersion, source: external('text/plain'),
      selector: { type: 'ByteRangeSelector', unit: 'byte', start: 4, end: 12 } },
    { version: locatorVersion, source: external('application/epub+zip'),
      selector: { type: 'EpubCfiSelector', cfi: 'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)' },
      quote: { type: 'TextQuoteSelector', exact: '引用', prefix: '', suffix: '。' } },
    { version: locatorVersion, source: external('text/x-renpy'),
      selector: { type: 'ScriptSelector', label: 'chapter_1', unit: 'utterance', utterance: 0, route: ['choice_a', 'route_b'] } },
  ]) {
    const bytes = JSON.stringify(value);
    const parsed = JSON.parse(bytes);
    expect(parseLocator(parsed)).toBe(parsed);
    expect(JSON.stringify(parsed)).toBe(bytes);
  }
});

test('G-510: exact source pins, version and selector units are required', () => {
  const valid = blockLocator('p');
  for (const value of [
    { ...valid, version: 'rezics-locator-v2' },
    { ...valid, source: { type: 'hosted', revision: 'r' } },
    { ...valid, source: { ...source, revision: '' } },
    { ...valid, source: { ...source, digest: digest.toUpperCase() } },
    { ...valid, source: { ...source, digest: `${digest}\n` } },
    { ...valid, source: { ...external('text/plain'), representationSha256: 'abc' } },
    { ...valid, source: external('text/plain; charset=utf-8') },
    { ...valid, source: external('text/plain\n') },
    { ...valid, selector: { type: 'BlockSelector', blockId: '' } },
    { ...valid, selector: { type: 'BlockSelector', blockId: 'p', range: { start: 0, end: 1 } } },
    { ...valid, selector: { type: 'BlockSelector', blockId: 'p', range: { unit: 'utf16', start: 0, end: 1 } } },
    { ...valid, unexpected: true },
  ]) {
    expect(checkLocator(value)).toBe(false);
    expect(() => parseLocator(value)).toThrow(TypeError);
  }
});

test('G-510: byte and code-point ranges reject malformed, unsafe or reversed positions', () => {
  for (const [start, end] of [[-1, 1], [0, -1], [2, 1], [0.5, 1], [0, Infinity], [NaN, 2], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    expect(checkLocator({ version: locatorVersion, source: external('text/plain'),
      selector: { type: 'ByteRangeSelector', unit: 'byte', start, end } })).toBe(false);
    expect(checkLocator({ version: locatorVersion, source,
      selector: { type: 'BlockSelector', blockId: 'p', range: { unit: 'code-point', start, end } } })).toBe(false);
  }
  expect(checkLocator({ version: locatorVersion, source: external('text/plain'),
    selector: { type: 'ByteRangeSelector', unit: 'byte', start: 1, end: 1 } })).toBe(false);
  // A block caret is valid; a byte evidence passage must select at least one byte.
  expect(checkLocator({ version: locatorVersion, source,
    selector: { type: 'BlockSelector', blockId: 'p', range: { unit: 'code-point', start: 1, end: 1 } } })).toBe(true);
});

test('G-510: opaque range CFI envelopes reject missing ranges and broken assertions without rewriting escapes', () => {
  for (const cfi of ['', 'not-cfi', 'epubcfi()', 'epubcfi(/6/4!/4/2/1:0)',
    'epubcfi(/6/4,/1:0,)', 'epubcfi(,/1:0,/1:2)', 'epubcfi(/6/4,/1:0,/1:2,/1:3)',
    'epubcfi(/6/4[bad,/1:0,/1:2)', 'epubcfi(/6/4],/1:0,/1:2)',
    'epubcfi(/6/4,/1:0,/1:2^)','epubcfi(/6/4,/1:0,(/1:2))', 'epubcfi(/6/4,/1:0,/1:2)\n']) {
    expect(checkLocator({ version: locatorVersion, source: external('application/epub+zip'),
      selector: { type: 'EpubCfiSelector', cfi } })).toBe(false);
  }
  const cfi = 'epubcfi(/6/4[chapter^,one]!/4/2,/1:0[字^]^^],/1:4[終])';
  const locator = parseLocator({ version: locatorVersion, source: external('application/epub+zip'),
    selector: { type: 'EpubCfiSelector', cfi } });
  expect(locator.selector).toEqual({ type: 'EpubCfiSelector', cfi });
});

test('G-510: script positions reject absent labels, malformed ordinals and route guards', () => {
  const valid = { type: 'ScriptSelector', label: 'start', unit: 'utterance', utterance: 0 };
  for (const selector of [
    { ...valid, label: '' }, { ...valid, label: 'two labels' }, { ...valid, label: 'start\n' },
    { ...valid, utterance: -1 }, { ...valid, utterance: 0.5 },
    { ...valid, utterance: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, unit: 'line' },
    { ...valid, route: [] }, { ...valid, route: ['a', 'a'] }, { ...valid, route: [''] },
  ]) expect(checkLocator({ version: locatorVersion, source: external('text/x-renpy'), selector })).toBe(false);
});

test('G-510: source media types cannot silently change a selector meaning', () => {
  expect(checkLocator({ version: locatorVersion, source, selector: {
    type: 'ByteRangeSelector', unit: 'byte', start: 0, end: 1,
  } })).toBe(false);
  expect(checkLocator({ version: locatorVersion, source: external('application/epub+zip'), selector: {
    type: 'ByteRangeSelector', unit: 'byte', start: 0, end: 1,
  } })).toBe(false);
  expect(checkLocator({ version: locatorVersion, source: external('text/plain'), selector: {
    type: 'EpubCfiSelector', cfi: 'epubcfi(/6/4,/1:0,/1:2)',
  } })).toBe(false);
});

test('G-510: insertion before identical paragraphs never substitutes text for block identity', () => {
  const pinned = snapshot([paragraph('first'), paragraph('target')]);
  const later = snapshot([paragraph('inserted'), ...pinned.blocks]);
  expect(resolveBlock(blockLocator('target'), pinned, later)).toEqual({ status: 'unchanged', id: 'target' });
  expect(resolveBlock(blockLocator('first'), pinned, later)).toEqual({ status: 'unchanged', id: 'first' });
  const quote: Locator = { version: locatorVersion, source,
    selector: { type: 'TextQuoteSelector', exact: 'Identical paragraph' } };
  expect(resolveBlock(quote, pinned, later)).toEqual({ status: 'ambiguous', candidates: [] });
});

test('G-510: moving, editing and deleting a pinned ID have distinct deterministic results', () => {
  const pinned = snapshot([paragraph('a'), paragraph('target'), paragraph('c')]);
  const locator = blockLocator('target');
  expect(resolveBlock(locator, pinned, snapshot([pinned.blocks[1]!, pinned.blocks[0]!, pinned.blocks[2]!]))).toEqual({ status: 'moved', id: 'target' });
  expect(resolveBlock(locator, pinned, snapshot([paragraph('a'), paragraph('target', 'Edited'), paragraph('c')]))).toEqual({ status: 'changed', candidates: ['target'] });
  expect(resolveBlock(locator, pinned, snapshot([paragraph('a'), paragraph('c')]))).toEqual({ status: 'deleted', candidates: [] });
  expect(resolveBlock(locator, pinned, snapshot([paragraph('replacement')]))).toEqual({ status: 'deleted', candidates: [] });
  // Reordering only siblings before the target leaves its relative position unchanged.
  const last = snapshot([paragraph('a'), paragraph('c'), paragraph('target')]);
  expect(resolveBlock(locator, last, snapshot([last.blocks[1]!, last.blocks[0]!, last.blocks[2]!]))).toEqual({ status: 'unchanged', id: 'target' });
  expect(resolveBlock(locator, pinned, snapshot([pinned.blocks[1]!, pinned.blocks[2]!]))).toEqual({ status: 'unchanged', id: 'target' });
});

test('G-510: splitting and merging return review candidates even when a surviving ID has identical text', () => {
  const pinned = snapshot([paragraph('target'), paragraph('other')]);
  const origin = { id: 'target', digest };
  const first = { ...paragraph('split-1'), lineage: { kind: 'split' as const, origins: [origin] } };
  const second = { ...paragraph('split-2'), lineage: { kind: 'split' as const, origins: [origin] } };
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([first, second]))).toEqual({ status: 'changed', candidates: ['split-1', 'split-2'] });
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([paragraph('target'), second]))).toEqual({ status: 'changed', candidates: ['target', 'split-2'] });
  const merged = { ...paragraph('target'), lineage: { kind: 'merge' as const,
    origins: [origin, { id: 'other', digest }] } };
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([merged]))).toEqual({ status: 'changed', candidates: ['target'] });
  expect(resolveBlock(blockLocator('other'), pinned, snapshot([merged]))).toEqual({ status: 'changed', candidates: ['target'] });
});

test('G-510: copies and origins from other pinned bytes cannot become the selected identity', () => {
  const pinned = snapshot([paragraph('target')]);
  const copy: DocumentBlock = { ...paragraph('copied'), lineage: { kind: 'copy', origins: [{ id: 'target', digest }] } };
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([copy, ...pinned.blocks]))).toEqual({ status: 'unchanged', id: 'target' });
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([copy]))).toEqual({ status: 'deleted', candidates: [] });
  const otherEdition: DocumentBlock = { ...paragraph('split'), lineage: {
    kind: 'split', origins: [{ id: 'target', digest: 'b'.repeat(64) }],
  } };
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([otherEdition]))).toEqual({ status: 'deleted', candidates: [] });
});

test('G-510: child identity survives unrelated child insertion and reports parent movement/reparenting', () => {
  const a = { ...paragraph('parent-a'), children: [paragraph('target')] };
  const b = paragraph('parent-b');
  const pinned = snapshot([a, b]);
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([{ ...a, children: [paragraph('new'), ...a.children] }, b]))).toEqual({ status: 'unchanged', id: 'target' });
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([b, a]))).toEqual({ status: 'moved', id: 'target' });
  expect(resolveBlock(blockLocator('target'), pinned, snapshot([{ ...a, children: [] }, { ...b, children: a.children }]))).toEqual({ status: 'moved', id: 'target' });
});

test('G-510: table-cell selection uses a stable ID through inserted rows, edits and cell reorder', () => {
  const cell = (id: string, text = 'cell') => ({ id, type: 'tableCell', content: [{ type: 'text', text, styles: {} }] });
  const table = (cells: ReturnType<typeof cell>[][]): DocumentBlock => ({ id: 'table', type: 'table',
    content: { type: 'tableContent', rows: cells.map(row => ({ cells: row })) } });
  const pinned = snapshot([table([[cell('left'), cell('target')]])]);
  const locator: Locator = { version: locatorVersion, source,
    selector: { type: 'BlockSelector', blockId: 'table', cellId: 'target', range: { unit: 'code-point', start: 0, end: 2 } } };
  expect(resolveBlock(locator, pinned, snapshot([table([[cell('new')], [cell('left'), cell('target')]])]))).toEqual({ status: 'unchanged', id: 'target' });
  expect(resolveBlock(locator, pinned, snapshot([table([[cell('target'), cell('left')]])]))).toEqual({ status: 'moved', id: 'target' });
  expect(resolveBlock(locator, pinned, snapshot([table([[cell('left')], [cell('target')]])]))).toEqual({ status: 'moved', id: 'target' });
  expect(resolveBlock(locator, pinned, snapshot([table([[cell('left'), cell('target', 'edited')]])]))).toEqual({ status: 'changed', candidates: ['target'] });
  expect(resolveBlock(locator, pinned, snapshot([table([[cell('left')]])]))).toEqual({ status: 'deleted', candidates: [] });
  expect(() => resolveBlock({ ...locator, selector: { type: 'BlockSelector', blockId: 'wrong', cellId: 'target' } }, pinned, pinned)).toThrow(TypeError);
  expect(() => resolveBlock(blockLocator('target'), pinned, pinned)).toThrow(TypeError);
  const child = snapshot([{ ...table([[cell('left')]]), children: [paragraph('child')] }]);
  expect(() => resolveBlock({ ...locator, selector: { type: 'BlockSelector', blockId: 'table', cellId: 'child' } }, child, child)).toThrow(TypeError);
});

test('G-510: property order is immaterial to identity, while unknown payload edits are changes', () => {
  const pinned = snapshot([{ id: 'future', type: 'future', props: { a: 1, b: 2 }, content: { raw: '字😀' } }]);
  const reordered = snapshot([{ type: 'future', id: 'future', content: { raw: '字😀' }, props: { b: 2, a: 1 } }]);
  expect(resolveBlock(blockLocator('future'), pinned, reordered)).toEqual({ status: 'unchanged', id: 'future' });
  expect(resolveBlock(blockLocator('future'), pinned, snapshot([{ ...pinned.blocks[0]!, content: { raw: 'edited' } }]))).toEqual({ status: 'changed', candidates: ['future'] });
});

test('G-510: invalid pinned IDs and duplicate IDs fail instead of producing a confident resolution', () => {
  const pinned = snapshot([paragraph('target')]);
  expect(() => resolveBlock(blockLocator('missing'), pinned, pinned)).toThrow(TypeError);
  expect(() => resolveBlock(blockLocator('target'), pinned, snapshot([paragraph('target'), paragraph('target')]))).toThrow(TypeError);
});

test('G-510: existing Content comments become quote locators without changing their target JSON', () => {
  const comment = { revisionId: 'revision-1', byteDigest: digest, target: {
    type: 'SpecificResource' as const, source: 'urn:rezics:content:revision:revision-1',
    selector: { type: 'TextQuoteSelector' as const, exact: 'Original paragraph', prefix: 'Opening\n', suffix: '\nClosing' },
  } };
  const bytes = JSON.stringify(comment);
  expect(Value.Check(ContentCommentTargetSchema, comment.target)).toBe(true);
  expect(locatorFromComment(comment)).toEqual({ version: locatorVersion, source, selector: comment.target.selector });
  expect(JSON.stringify(comment)).toBe(bytes);
  expect(() => locatorFromComment({ ...comment, revisionId: 'different-revision' })).toThrow(TypeError);
  expect(() => locatorFromComment({ ...comment, byteDigest: 'invalid' })).toThrow(TypeError);
});

test('G-510 property: random edit scripts preserve untouched IDs and every unknown payload byte', () => {
  const action = fc.record({ kind: fc.constantFrom('insert', 'move', 'edit', 'delete', 'split'),
    position: fc.nat(1000), destination: fc.nat(1000), text: fc.string() });
  fc.assert(fc.property(fc.jsonValue(), fc.array(action, { maxLength: 50 }), (unknown, actions) => {
    const opaque: DocumentBlock = { id: 'opaque', type: 'future-widget', content: unknown, extension: { bytes: '  字😀\n  ' } };
    const pinned = snapshot([paragraph('target'), opaque, paragraph('initial')]);
    const unknownBytes = JSON.stringify(opaque);
    let blocks = [...pinned.blocks];
    let nextId = 0;
    for (const action of actions) {
      const index = action.position % blocks.length;
      const selected = blocks[index]!;
      const id = `new-${nextId++}`;
      if (action.kind === 'insert') blocks.splice(index, 0, paragraph(id, action.text));
      if (action.kind === 'move') {
        blocks.splice(index, 1);
        blocks.splice(action.destination % (blocks.length + 1), 0, selected);
      }
      if (selected.id !== 'target' && selected.id !== 'opaque') {
        if (action.kind === 'edit') blocks[index] = paragraph(selected.id, action.text);
        if (action.kind === 'delete') blocks.splice(index, 1);
        if (action.kind === 'split') blocks.splice(index, 1,
          { ...paragraph(id, action.text), lineage: { kind: 'split', origins: [{ id: selected.id, digest }] } });
      }
      const later = snapshot(blocks);
      expect(checkDocument(later)).toBe(true);
      expect(JSON.stringify(parseDocument(later).blocks.find(block => block.id === 'opaque'))).toBe(unknownBytes);
      for (const preserved of ['target', 'opaque']) {
        const result = resolveBlock(blockLocator(preserved), pinned, later);
        expect(['unchanged', 'moved']).toContain(result.status);
      }
      expect(blocks.find(block => block.id === 'target')).toBe(pinned.blocks[0]);
    }
  }), { seed, numRuns: 100 });
});
