import { expect, test } from 'bun:test';
import { checkDocument, type DocumentNode } from '@rezics/document';
import { undo, redo } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { canRunBlockAction, runBlockAction } from '../src/components/editor-block-actions.tsx';
import { indentList, outdentList, splitCurrentListItem, toggleTask } from '../src/components/editor-list-behavior.ts';
import { runTableCommand, tableCommands, tablesWithinDocumentBound } from '../src/components/editor-table-commands.ts';
import { isLinkRangeValid, revalidateTextSelection } from '../src/components/editor-link.tsx';
import { documentIds, editorStateFixture, nodePositions } from './helpers/editor-state.ts';

test('block movement preserves a complete subtree, duplication renews every ID, and history restores both', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [
      {
        type: 'blockquote',
        attrs: { id: 'quote' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'paragraph' },
            content: [
              { type: 'text', text: 'Structured' },
              {
                type: 'extensionInline',
                attrs: {
                  id: 'opaque-inline',
                  definition: 'example',
                  version: '1',
                  payload: { nested: ['retained'] },
                  fallback: 'component',
                },
              },
            ],
          },
        ],
      },
      { type: 'paragraph', attrs: { id: 'after' }, content: [{ type: 'text', text: 'After' }] },
    ],
  });
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 3));
  const oldIds = documentIds(editor).sort();
  expect(runBlockAction(editor, 'moveBlockDown', () => true)).toBe(true);
  expect(documentIds(editor).sort()).toEqual(oldIds);
  expect(editor.state.doc.child(1).attrs.id).toBe('quote');
  expect(editor.state.selection.$from.node(1).attrs.id).toBe('quote');
  expect(runBlockAction(editor, 'duplicateBlock', () => true)).toBe(true);
  const ids = documentIds(editor);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(oldIds.length + 3);
  expect(editor.state.doc.child(2).attrs.id).not.toBe('quote');
  expect(nodePositions(editor, 'extensionInline').map(({ node }) => node.attrs.payload)).toEqual([
    { nested: ['retained'] },
    { nested: ['retained'] },
  ]);
  expect(checkDocument(fixture.snapshot())).toBe(true);
  expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(editor.state.doc.childCount).toBe(2);
  expect(redo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(new Set(documentIds(editor)).size).toBe(documentIds(editor).length);
});

test('selected top-level atoms have block actions; deleting the final block leaves an editable paragraph', () => {
  const fixture = editorStateFixture({ type: 'doc', content: [{ type: 'horizontalRule', attrs: { id: 'divider' } }] });
  const { editor } = fixture;
  fixture.select(NodeSelection.create(editor.state.doc, 0));
  expect(canRunBlockAction(editor, 'duplicateBlock')).toBe(true);
  expect(runBlockAction(editor, 'deleteBlock', () => false)).toBe(false);
  fixture.setEditable(false);
  expect(runBlockAction(editor, 'deleteBlock', () => true)).toBe(false);
  fixture.setEditable(true);
  expect(runBlockAction(editor, 'deleteBlock', () => true)).toBe(true);
  expect(editor.state.doc.childCount).toBe(1);
  expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
  expect(editor.state.doc.firstChild!.content.size).toBe(0);
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

test('a referenced footnote definition cannot be deleted by a generic block action', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'footnoteReference', attrs: { label: 'shared' } }] },
      {
        type: 'footnoteDefinition',
        attrs: { label: 'shared' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich body' }] }],
      },
    ],
  });
  const { editor } = fixture;
  fixture.select(NodeSelection.create(editor.state.doc, nodePositions(editor, 'footnoteDefinition')[0]!.pos));
  expect(canRunBlockAction(editor, 'deleteBlock')).toBe(false);
  expect(runBlockAction(editor, 'deleteBlock', () => true)).toBe(false);
  expect(runBlockAction(editor, 'duplicateBlock', () => true)).toBe(true);
  expect(nodePositions(editor, 'footnoteDefinition').map(({ node }) => node.attrs.label)).toEqual([
    'shared',
    'shared-copy-1',
  ]);
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

test('native task splitting resets the new item, nesting/lifting preserves content and task toggles are undoable', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [
      {
        type: 'taskList',
        attrs: { id: 'tasks' },
        content: [
          {
            type: 'taskItem',
            attrs: { id: 'one', checked: true },
            content: [{ type: 'paragraph', attrs: { id: 'one-body' }, content: [{ type: 'text', text: 'First' }] }],
          },
          {
            type: 'taskItem',
            attrs: { id: 'two', checked: false },
            content: [{ type: 'paragraph', attrs: { id: 'two-body' }, content: [{ type: 'text', text: 'Second' }] }],
          },
        ],
      },
    ],
  });
  const { editor } = fixture;
  const body = nodePositions(editor, 'paragraph')[1]!;
  fixture.select(TextSelection.create(editor.state.doc, body.pos + 3));
  expect(indentList(editor)).toBe(true);
  expect(nodePositions(editor, 'taskList')).toHaveLength(2);
  expect(outdentList(editor)).toBe(true);
  expect(nodePositions(editor, 'taskList')).toHaveLength(1);
  expect(toggleTask(editor)).toBe(true);
  expect(nodePositions(editor, 'taskItem').find(({ node }) => node.attrs.id === 'two')!.node.attrs.checked).toBe(true);
  expect(splitCurrentListItem(editor)).toBe(true);
  const items = nodePositions(editor, 'taskItem');
  expect(items).toHaveLength(3);
  expect(items[1]!.node.attrs.id).toBe('two');
  expect(items[2]!.node.attrs.checked).toBe(false);
  expect(items[1]!.node.textContent + items[2]!.node.textContent).toBe('Second');
  fixture.setEditable(false);
  expect(toggleTask(editor)).toBe(false);
  fixture.setEditable(true);
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

function tableDoc(): DocumentNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'table',
        attrs: { id: 'grid' },
        content: Array.from({ length: 2 }, (_, row) => ({
          type: 'tableRow',
          attrs: { id: `row-${row}` },
          content: Array.from({ length: 3 }, (_, col) => ({
            type: 'tableCell',
            attrs: { id: `cell-${row}-${col}` },
            content: [
              {
                type: 'paragraph',
                attrs: { id: `body-${row}-${col}` },
                content: [{ type: 'text', text: `${row},${col}` }],
              },
            ],
          })),
        })),
      },
    ],
  };
}

test('table row/column selection, alignment, merge/split and row movement use the same maintained geometry', () => {
  const fixture = editorStateFixture(tableDoc());
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, nodePositions(editor, 'paragraph')[0]!.pos + 1));
  expect(runTableCommand(editor, 'selectColumn', () => true)).toBe(true);
  expect(editor.state.selection instanceof CellSelection).toBe(true);
  expect((editor.state.selection as CellSelection).isColSelection()).toBe(true);
  expect(runTableCommand(editor, 'alignCellCenter', () => true)).toBe(true);
  expect(nodePositions(editor, 'tableCell').filter(({ node }) => node.attrs.align === 'center')).toHaveLength(2);
  const cells = nodePositions(editor, 'tableCell');
  fixture.select(new CellSelection(editor.state.doc.resolve(cells[0]!.pos), editor.state.doc.resolve(cells[4]!.pos)));
  expect(runTableCommand(editor, 'mergeCells', () => true)).toBe(true);
  expect(nodePositions(editor, 'tableCell')[0]!.node.attrs).toMatchObject({ id: 'cell-0-0', rowspan: 2, colspan: 2 });
  expect(runTableCommand(editor, 'splitCell', () => true)).toBe(true);
  expect(TableMap.get(editor.state.doc.firstChild!).problems).toBeNull();
  fixture.select(TextSelection.create(editor.state.doc, nodePositions(editor, 'paragraph')[0]!.pos + 1));
  expect(runTableCommand(editor, 'moveRowDown', () => true)).toBe(true);
  expect(editor.state.doc.firstChild!.child(1).attrs.id).toBe('row-0');
  expect(runTableCommand(editor, 'selectTable', () => true)).toBe(true);
  expect(runTableCommand(editor, 'toggleHeaderCell', () => true)).toBe(true);
  expect(nodePositions(editor, 'tableHeader')).toHaveLength(6);
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

test('table budget is proven before expansion for full tables and copied cell slices', () => {
  const fixture = editorStateFixture(tableDoc());
  const { schema } = fixture.editor;
  const cell = schema.nodes.tableCell!.create({ colspan: Number.MAX_SAFE_INTEGER }, schema.nodes.paragraph!.create());
  const table = schema.nodes.table!.create(null, schema.nodes.tableRow!.create(null, cell));
  expect(tablesWithinDocumentBound(table)).toBe(false);
  expect(tablesWithinDocumentBound(table.content)).toBe(false);
  expect(tablesWithinDocumentBound(table.firstChild!.content)).toBe(false);
  expect(tablesWithinDocumentBound(fixture.editor.state.doc)).toBe(true);
});

test('merging an entire 2×2 table creates a covered empty row, preserves surviving IDs, and undoes exactly', () => {
  const value = tableDoc();
  for (const row of value.content![0]!.content!) row.content = row.content!.slice(0, 2);
  const fixture = editorStateFixture(value);
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, nodePositions(editor, 'paragraph')[0]!.pos + 1));
  const original = editor.state.doc;
  expect(runTableCommand(editor, 'selectTable', () => true)).toBe(true);
  expect(runTableCommand(editor, 'mergeCells', () => true)).toBe(true);
  const table = editor.state.doc.firstChild!;
  expect(table.firstChild!.firstChild!.attrs).toMatchObject({ id: 'cell-0-0', rowspan: 2, colspan: 2 });
  expect(table.child(1).childCount).toBe(0);
  expect(table.child(1).attrs.id).toBe('row-1');
  expect(nodePositions(editor, 'paragraph').map(({ node }) => node.attrs.id)).toEqual([
    'body-0-0',
    'body-0-1',
    'body-1-0',
    'body-1-1',
  ]);
  expect(TableMap.get(table).problems).toBeNull();
  expect(checkDocument(fixture.snapshot())).toBe(true);
  for (const command of Object.values(tableCommands)) expect(() => command(editor.state)).not.toThrow();
  expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(editor.state.doc.eq(original)).toBe(true);
  expect(redo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

test('table availability and row movement work after preceding blocks and disable ambiguous merged-unit moves', () => {
  const value = tableDoc();
  value.content!.unshift({
    type: 'paragraph',
    attrs: { id: 'before' },
    content: [{ type: 'text', text: 'A long preceding block shifts every table position.' }],
  });
  const fixture = editorStateFixture(value);
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, nodePositions(editor, 'tableCell')[0]!.pos + 2));
  for (const command of Object.values(tableCommands)) expect(() => command(editor.state)).not.toThrow();
  expect(runTableCommand(editor, 'moveRowDown', () => true)).toBe(true);
  expect(editor.state.doc.child(1).child(1).attrs.id).toBe('row-0');
  expect(runTableCommand(editor, 'selectTable', () => true)).toBe(true);
  expect(runTableCommand(editor, 'mergeCells', () => true)).toBe(true);
  expect(tableCommands.moveRowUp(editor.state)).toBe(false);
  expect(tableCommands.moveRowDown(editor.state)).toBe(false);
});

test('controlled echoes preserve cell and block selections without inventing invalid inline endpoints', () => {
  const fixture = editorStateFixture(tableDoc());
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, nodePositions(editor, 'paragraph')[0]!.pos + 1));
  expect(runTableCommand(editor, 'selectTable', () => true)).toBe(true);
  const cells = editor.state.selection;
  const before = fixture.transactionCount;
  expect(isLinkRangeValid(editor, { from: cells.from, to: cells.to })).toBe(false);
  expect(revalidateTextSelection(editor)).toBe(true);
  expect(editor.state.selection).toBe(cells);
  expect(fixture.transactionCount).toBe(before);
  fixture.select(NodeSelection.create(editor.state.doc, 0));
  const block = editor.state.selection;
  expect(revalidateTextSelection(editor)).toBe(true);
  expect(editor.state.selection).toBe(block);
  fixture.select(
    TextSelection.create(
      editor.state.doc,
      nodePositions(editor, 'paragraph')[0]!.pos + 3,
      nodePositions(editor, 'paragraph')[0]!.pos + 1,
    ),
  );
  const backwards = editor.state.selection;
  expect(revalidateTextSelection(editor)).toBe(true);
  expect(editor.state.selection).toBe(backwards);
});
