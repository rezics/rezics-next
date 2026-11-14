import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type Node } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection, type Command, type Selection, type Transaction } from '@tiptap/pm/state';
import {
  TableView,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  addRowBefore,
  addRowAfter,
  deleteRow,
  mergeCells,
  splitCell,
  deleteTable,
  columnResizing,
  goToNextCell,
  isInTable,
  tableEditing,
  toggleHeaderRow,
  toggleHeaderColumn,
  type TableRole,
} from '@tiptap/pm/tables';

/** The upstream control groups operate on the existing document schema and history. */
export const tableCommandGroups = [
  ['addColumnBefore', 'addColumnAfter', 'deleteColumn'],
  ['addRowBefore', 'addRowAfter', 'deleteRow'],
  ['mergeCells', 'splitCell'],
  ['toggleHeaderRow', 'toggleHeaderColumn'],
  ['deleteTable'],
] as const;

export const tableCommands = {
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  addRowBefore,
  addRowAfter,
  deleteRow,
  mergeCells,
  splitCell,
  toggleHeaderRow,
  toggleHeaderColumn,
  deleteTable,
} satisfies Record<string, Command>;

export type TableCommandName = keyof typeof tableCommands;

export interface TableSizeOptions {
  rows: number;
  cols: number;
  withHeaderRow: boolean;
}

export interface TableInsertTarget {
  doc: Node;
  selection: Selection;
  slash?: { from: number; to: number; query: string };
}

export function canInsertSizedTable(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing ||
    !['table', 'tableRow', 'tableCell', 'tableHeader', 'paragraph'].every((name) => editor.schema.nodes[name]) ||
    !editor.state.selection.$from.parent.isTextblock || isInTable(editor.state)) return false;
  const { $from } = editor.state.selection;
  const parent = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  return parent.canReplaceWith(index + 1, index + 1, editor.schema.nodes.table!);
}

/** Map an open size chooser only while it still owns the same untouched selection and optional slash. */
export function mapTableInsertTarget(target: TableInsertTarget, transaction: Transaction, editor: Editor): TableInsertTarget | null {
  if (transaction.before !== target.doc) return null;
  const from = transaction.mapping.map(target.selection.from, 1);
  const to = transaction.mapping.map(target.selection.to, target.selection.empty ? 1 : -1);
  if (target.selection.empty && transaction.mapping.map(target.selection.from, -1) !== from) return null;
  if (from > to || !target.doc.slice(target.selection.from, target.selection.to).eq(editor.state.doc.slice(from, to))) return null;
  const selection = target.selection.getBookmark().map(transaction.mapping).resolve(editor.state.doc);
  if (!selection.eq(editor.state.selection)) return null;
  let slash = target.slash;
  if (slash) {
    const start = transaction.mapping.map(slash.from, 1);
    const end = transaction.mapping.map(slash.to, -1);
    if (start >= end || editor.state.doc.textBetween(start, end) !== `/${slash.query}`) return null;
    slash = { ...slash, from: start, to: end };
  }
  return { doc: editor.state.doc, selection, ...(slash ? { slash } : {}) };
}

/** A single schema transaction deletes an admitted slash and inserts the deliberately sized table. */
export function insertSizedTable(editor: Editor, target: TableInsertTarget, options: TableSizeOptions, isCurrent: () => boolean): boolean {
  if (!isCurrent() || !canInsertSizedTable(editor) || editor.state.doc !== target.doc || !editor.state.selection.eq(target.selection)) return false;
  if (![options.rows, options.cols].every((value) => Number.isInteger(value) && value >= 1 && value <= 10)) return false;
  const { schema } = editor.state;
  const transaction = closeHistory(editor.state.tr);
  if (target.slash) {
    const { from, to, query } = target.slash;
    if (transaction.doc.textBetween(from, to) !== `/${query}`) return false;
    transaction.delete(from, to);
  }
  const { $from } = transaction.selection;
  if (!$from.parent.isTextblock) return false;
  const attrs = Object.fromEntries(['lang', 'dir'].flatMap((key) =>
    $from.parent.attrs[key] == null ? [] : [[key, $from.parent.attrs[key]]],
  ));
  const rows = Array.from({ length: options.rows }, (_, row) => schema.nodes.tableRow!.create(null,
    Array.from({ length: options.cols }, () => {
      const type = row === 0 && options.withHeaderRow ? schema.nodes.tableHeader! : schema.nodes.tableCell!;
      return type.create(null, schema.nodes.paragraph!.create(attrs));
    }),
  ));
  const table = schema.nodes.table!.create(attrs, rows);
  const emptyParagraph = $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0;
  const parent = $from.node($from.depth - 1);
  const blockIndex = $from.index($from.depth - 1);
  // List items must keep their leading paragraph, even when the slash emptied it.
  const replaceEmpty = emptyParagraph && parent.canReplace(blockIndex, blockIndex + 1, Fragment.from([table, $from.parent]));
  const at = replaceEmpty ? $from.before() : $from.after();
  const tail = replaceEmpty ? $from.parent : schema.nodes.paragraph!.create(attrs);
  const index = blockIndex + (replaceEmpty ? 0 : 1);
  const content = Fragment.from([table, tail]);
  if (!parent.canReplace(index, index + (replaceEmpty ? 1 : 0), content)) return false;
  transaction.replaceWith(at, replaceEmpty ? $from.after() : at, content);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(at + 3))).scrollIntoView();
  const before = editor.state;
  editor.view.dispatch(transaction);
  return editor.state !== before;
}

export function runTableCommand(editor: Editor, name: TableCommandName, isCurrent: () => boolean): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const before = editor.state;
  const handled = tableCommands[name](before, (transaction) => editor.view.dispatch(transaction));
  if (handled && isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  return handled && editor.state !== before;
}

const roles: Record<string, TableRole> = {
  table: 'table',
  tableRow: 'row',
  tableCell: 'cell',
  tableHeader: 'header_cell',
};

/** Keep the document's identity and language on the maintained resizing node view. */
class DocumentTableView extends TableView {
  constructor(node: Node, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.updateAttributes(node);
  }

  override update(node: Node): boolean {
    if (!super.update(node)) return false;
    this.updateAttributes(node);
    return true;
  }

  private updateAttributes(node: Node) {
    for (const [attribute, value] of [
      ['data-block-id', node.attrs.id],
      ['lang', node.attrs.lang],
      ['dir', node.attrs.dir],
    ] as const) {
      if (value) this.table.setAttribute(attribute, String(value));
      else this.table.removeAttribute(attribute);
    }
  }
}

export const EditorTables = Extension.create({
  name: 'documentTableEditing',
  // Table selection/paste handling must run after the more specific editor handlers.
  priority: 50,
  extendNodeSchema(extension) {
    const tableRole = roles[extension.name];
    return tableRole ? { tableRole, ...(tableRole === 'table' || tableRole === 'row' ? {} : { isolating: true }) } : {};
  },
  addProseMirrorPlugins() {
    return [
      columnResizing({ View: DocumentTableView, cellMinWidth: 48, defaultCellMinWidth: 96 }),
      tableEditing(),
    ];
  },
  addKeyboardShortcuts() {
    const move = (direction: 1 | -1) => {
      const editor = this.editor;
      if (!editor.isEditable || editor.view.composing || !isInTable(editor.state)) return false;
      if (goToNextCell(direction)(editor.state, (transaction) => editor.view.dispatch(transaction))) return true;
      if (direction === -1) return false;
      if (!addRowAfter(editor.state, (transaction) => editor.view.dispatch(transaction))) return false;
      return goToNextCell(1)(editor.state, (transaction) => editor.view.dispatch(transaction));
    };
    return { Tab: () => move(1), 'Shift-Tab': () => move(-1) };
  },
});
