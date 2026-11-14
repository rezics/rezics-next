// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { BlocksSnapshotSchema, checkDocument, documentVersion, normalizeDocument, parseDocument,
  schemaForProfile, serializeDocument, type DocumentNode, type DocumentSnapshot } from '../src/index.ts';
import { DOCUMENT_TABLE_MAP_CELL_BUDGET, tableMapFitsBudget } from '../src/table-map-budget.ts';

const cell = (id: string, colspan = 1, rowspan = 1): DocumentNode => ({
  type: 'tableCell', attrs: { id, colspan, rowspan }, content: [{ type: 'paragraph', attrs: { id: `${id}-body` }, content: [{ type: 'text', text: id }] }],
});
const row = (id: string, content?: DocumentNode[]): DocumentNode => ({ type: 'tableRow', attrs: { id }, ...(content ? { content } : {}) });
const table = (content: DocumentNode[]): DocumentNode => ({ type: 'table', attrs: { id: 'table' }, content });
const snapshot = (content: DocumentNode[]): DocumentSnapshot => ({ version: documentVersion, profile: 'blocks', doc: { type: 'doc', content } });

test('a rowspan-covered physical empty row is accepted by wire/runtime schemas and retains IDs through canonical roundtrip', () => {
  for (const emptyRow of [row('covered'), row('covered', [])]) {
    const value = snapshot([table([row('source', [cell('merged', 2, 2)]), emptyRow])]);
    expect(Compile(BlocksSnapshotSchema).Check(value)).toBe(true);
    expect(checkDocument(value)).toBe(true);
    const normalized = normalizeDocument(value);
    expect(parseDocument(JSON.parse(serializeDocument(normalized)))).toEqual(normalized);
    expect(normalized.doc.content![0]!.content!.map((node) => node.attrs!.id)).toEqual(['source', 'covered']);
    const node = schemaForProfile('blocks').nodeFromJSON(normalized.doc);
    node.check();
    expect(node.firstChild!.child(1).childCount).toBe(0);
    expect(node.firstChild!.firstChild!.firstChild!.attrs.id).toBe('merged');
  }
});

test('uncovered empty rows, all-empty tables, overlapping spans and spans beyond the final row remain invalid', () => {
  const cases = [
    table([row('first', [cell('uncovered', 2)]), row('empty')]),
    table([row('empty-first'), row('empty-second', [])]),
    table([row('empty-first'), row('second', [cell('later')])]),
    table([row('first', [cell('left'), cell('right', 1, 2)]), row('second', [cell('overlap', 2)])]),
    table([row('first', [cell('too-tall', 1, 3)]), row('covered')]),
  ];
  for (const invalid of cases) expect(checkDocument(snapshot([invalid]))).toBe(false);
});

test('covered empty rows retain the pre-map expanded bound and require at least one physical cell', () => {
  const covered = table([row('first', [cell('wide', 32_768, 2)]), row('covered')]);
  expect(tableMapFitsBudget(covered, DOCUMENT_TABLE_MAP_CELL_BUDGET)).toBe(true);
  expect(tableMapFitsBudget(covered, DOCUMENT_TABLE_MAP_CELL_BUDGET - 1)).toBe(false);
  expect(tableMapFitsBudget(table([row('first', [cell('overflow', Number.MAX_SAFE_INTEGER, 2)]), row('covered')]), Number.MAX_SAFE_INTEGER)).toBe(false);
  expect(tableMapFitsBudget(table([row('empty')]), DOCUMENT_TABLE_MAP_CELL_BUDGET)).toBe(false);
});
