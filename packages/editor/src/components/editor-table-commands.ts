import { Extension, type Editor } from '@tiptap/core';
import { DOCUMENT_TABLE_MAP_CELL_BUDGET } from '@rezics/document';
import { Fragment, type Node } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, TextSelection, type Command, type Selection, type Transaction } from '@tiptap/pm/state';
import {
  TableView,
  TableMap,
  CellSelection,
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
  toggleHeaderCell,
  selectedRect,
  setCellAttr,
  moveTableRow,
  moveTableColumn,
  columnResizingPluginKey,
  type TableRole,
} from '@tiptap/pm/tables';

/** The upstream control groups operate on the existing document schema and history. */
export const tableCommandGroups = [
  ['addColumnBefore', 'addColumnAfter', 'deleteColumn'],
  ['addRowBefore', 'addRowAfter', 'deleteRow'],
  ['mergeCells', 'splitCell'],
  ['toggleHeaderRow', 'toggleHeaderColumn', 'toggleHeaderCell'],
  ['selectRow', 'selectColumn', 'selectTable'],
  ['alignCellLeft', 'alignCellCenter', 'alignCellRight', 'alignCellDefault'],
  ['moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'],
  ['deleteTable'],
] as const;

function selectCells(kind: 'row' | 'column' | 'table'): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const { map, tableStart, top, bottom, left, right } = selectedRect(state);
    const at = (row: number, column: number) => state.doc.resolve(tableStart + map.map[row * map.width + column]!);
    const selection =
      kind === 'row'
        ? CellSelection.rowSelection(at(top, left), at(bottom - 1, right - 1))
        : kind === 'column'
          ? CellSelection.colSelection(at(top, left), at(bottom - 1, right - 1))
          : new CellSelection(at(0, 0), at(map.height - 1, map.width - 1));
    dispatch?.(state.tr.setSelection(selection));
    return true;
  };
}

function moveTableUnit(axis: 'row' | 'column', direction: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const from = axis === 'row' ? rect.top : rect.left;
    const to = from + direction;
    const bound = axis === 'row' ? rect.map.height : rect.map.width;
    if (to < 0 || to >= bound) return false;
    let spans = false;
    rect.table.forEach((row) =>
      row.forEach((cell) => {
        if (cell.attrs.rowspan > 1 || cell.attrs.colspan > 1) spans = true;
      }),
    );
    if (spans) return false;
    const move =
      axis === 'row' ? moveTableRow({ from, to, select: false }) : moveTableColumn({ from, to, select: false });
    if (!dispatch) return move(state);
    return move(state, (transaction) => {
      if (axis === 'row') {
        // The maintained helper reorders cells while retaining positional row attrs. Identity follows the moved row.
        const originalRows = new Map<Fragment, { node: Node; index: number }>();
        rect.table.forEach((row, _offset, index) =>
          row.forEach((cell) => {
            originalRows.set(cell.content, { node: row, index });
          }),
        );
        const table = transaction.doc.nodeAt(rect.tableStart - 1);
        let previousIndex = -1;
        table?.forEach((row, offset) => {
          const original = row.firstChild
            ? originalRows.get(row.firstChild.content)
            : { node: rect.table.child(previousIndex + 1), index: previousIndex + 1 };
          if (original) {
            previousIndex = original.index;
            transaction.setNodeMarkup(rect.tableStart + offset, undefined, original.node.attrs);
          }
        });
      }
      const table = transaction.doc.nodeAt(rect.tableStart - 1)!;
      const map = TableMap.get(table);
      const at = (row: number, col: number) =>
        transaction.doc.resolve(rect.tableStart + map.map[row * map.width + col]!);
      transaction.setSelection(
        axis === 'row'
          ? CellSelection.rowSelection(at(to, 0), at(to, map.width - 1))
          : CellSelection.colSelection(at(0, to), at(map.height - 1, to)),
      );
      dispatch(transaction);
    });
  };
}

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
  toggleHeaderCell,
  selectRow: selectCells('row'),
  selectColumn: selectCells('column'),
  selectTable: selectCells('table'),
  alignCellLeft: setCellAttr('align', 'left'),
  alignCellCenter: setCellAttr('align', 'center'),
  alignCellRight: setCellAttr('align', 'right'),
  alignCellDefault: setCellAttr('align', null),
  moveRowUp: moveTableUnit('row', -1),
  moveRowDown: moveTableUnit('row', 1),
  moveColumnLeft: moveTableUnit('column', -1),
  moveColumnRight: moveTableUnit('column', 1),
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
  if (
    editor.isDestroyed ||
    !editor.isEditable ||
    editor.view.composing ||
    !['table', 'tableRow', 'tableCell', 'tableHeader', 'paragraph'].every((name) => editor.schema.nodes[name]) ||
    !editor.state.selection.$from.parent.isTextblock ||
    isInTable(editor.state)
  )
    return false;
  const { $from } = editor.state.selection;
  const parent = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  return parent.canReplaceWith(index + 1, index + 1, editor.schema.nodes.table!);
}

/** Map an open size chooser only while it still owns the same untouched selection and optional slash. */
export function mapTableInsertTarget(
  target: TableInsertTarget,
  transaction: Transaction,
  editor: Editor,
): TableInsertTarget | null {
  if (transaction.before !== target.doc) return null;
  const from = transaction.mapping.map(target.selection.from, 1);
  const to = transaction.mapping.map(target.selection.to, target.selection.empty ? 1 : -1);
  if (target.selection.empty && transaction.mapping.map(target.selection.from, -1) !== from) return null;
  if (from > to || !target.doc.slice(target.selection.from, target.selection.to).eq(editor.state.doc.slice(from, to)))
    return null;
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
export function insertSizedTable(
  editor: Editor,
  target: TableInsertTarget,
  options: TableSizeOptions,
  isCurrent: () => boolean,
): boolean {
  if (
    !isCurrent() ||
    !canInsertSizedTable(editor) ||
    editor.state.doc !== target.doc ||
    !editor.state.selection.eq(target.selection)
  )
    return false;
  if (![options.rows, options.cols].every((value) => Number.isInteger(value) && value >= 1 && value <= 10))
    return false;
  const { schema } = editor.state;
  const transaction = closeHistory(editor.state.tr);
  if (target.slash) {
    const { from, to, query } = target.slash;
    if (transaction.doc.textBetween(from, to) !== `/${query}`) return false;
    transaction.delete(from, to);
  }
  const { $from } = transaction.selection;
  if (!$from.parent.isTextblock) return false;
  const attrs = Object.fromEntries(
    ['lang', 'dir'].flatMap((key) => ($from.parent.attrs[key] == null ? [] : [[key, $from.parent.attrs[key]]])),
  );
  const rows = Array.from({ length: options.rows }, (_, row) =>
    schema.nodes.tableRow!.create(
      null,
      Array.from({ length: options.cols }, () => {
        const type = row === 0 && options.withHeaderRow ? schema.nodes.tableHeader! : schema.nodes.tableCell!;
        return type.create(null, schema.nodes.paragraph!.create(attrs));
      }),
    ),
  );
  const table = schema.nodes.table!.create(attrs, rows);
  const emptyParagraph = $from.parent.type === schema.nodes.paragraph && $from.parent.content.size === 0;
  const parent = $from.node($from.depth - 1);
  const blockIndex = $from.index($from.depth - 1);
  // List items must keep their leading paragraph, even when the slash emptied it.
  const replaceEmpty =
    emptyParagraph && parent.canReplace(blockIndex, blockIndex + 1, Fragment.from([table, $from.parent]));
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
  const handled = tableCommands[name](before, (transaction) => editor.view.dispatch(closeHistory(transaction)));
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

/** Prove the contract's static bound without allocating a dense TableMap. */
export function tablesWithinDocumentBound(content: Node | Fragment): boolean {
  let valid = true;
  const checkRows = (rows: readonly Node[]) => {
    let columns = 0;
    rows.forEach((row, rowIndex) =>
      row.forEach((cell) => {
        const colspan = cell.attrs.colspan;
        const rowspan = cell.attrs.rowspan;
        if (
          !Number.isSafeInteger(colspan) ||
          colspan < 1 ||
          !Number.isSafeInteger(rowspan) ||
          rowspan < 1 ||
          rowspan > rows.length - rowIndex
        )
          valid = false;
        columns += colspan;
        if (
          !Number.isSafeInteger(columns) ||
          !Number.isSafeInteger(columns * rows.length) ||
          columns * rows.length > DOCUMENT_TABLE_MAP_CELL_BUDGET
        )
          valid = false;
      }),
    );
    if (columns < 1) valid = false;
  };
  const visit = (node: Node) => {
    if (!valid) return;
    if (node.type.name === 'table') {
      checkRows(Array.from({ length: node.childCount }, (_, index) => node.child(index)));
    }
    node.forEach(visit);
  };
  if ('type' in content) visit(content);
  else {
    const nodes = Array.from({ length: content.childCount }, (_, index) => content.child(index));
    if (nodes.length && nodes.every((node) => node.type.name === 'tableRow')) checkRows(nodes);
    if (nodes.length && nodes.every((node) => ['tableCell', 'tableHeader'].includes(node.type.name))) {
      let columns = 0;
      let rows = 1;
      for (const node of nodes) {
        columns += node.attrs.colspan;
        rows = Math.max(rows, node.attrs.rowspan);
      }
      if (
        !Number.isSafeInteger(columns) ||
        !Number.isSafeInteger(rows) ||
        columns < 1 ||
        rows < 1 ||
        columns * rows > DOCUMENT_TABLE_MAP_CELL_BUDGET
      )
        valid = false;
    }
    content.forEach(visit);
  }
  return valid;
}

export const EditorTables = Extension.create<{ onInvalidContent?: () => void }>({
  name: 'documentTableEditing',
  addOptions: () => ({}),
  // Table selection/paste handling must run after the more specific editor handlers.
  priority: 50,
  extendNodeSchema(extension) {
    const tableRole = roles[extension.name];
    return tableRole ? { tableRole, ...(tableRole === 'row' ? {} : { isolating: true }) } : {};
  },
  addProseMirrorPlugins() {
    const invalid = this.options.onInvalidContent;
    return [
      new Plugin({
        filterTransaction(transaction) {
          if (!transaction.docChanged || tablesWithinDocumentBound(transaction.doc)) return true;
          invalid?.();
          return false;
        },
        appendTransaction(transactions, _before, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return;
          const transaction = state.tr;
          state.doc.descendants((node, pos) => {
            if (
              !['tableCell', 'tableHeader'].includes(node.type.name) ||
              !Array.isArray(node.attrs.colwidth) ||
              !node.attrs.colwidth.some((width: number) => width === 0)
            )
              return;
            // PM uses zero for an unmeasured spanned column; Document persists explicit positive widths.
            transaction.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              colwidth: node.attrs.colwidth.map((width: number) => width || 96),
            });
          });
          return transaction.docChanged ? transaction : undefined;
        },
        props: {
          handlePaste(_view, _event, slice) {
            if (tablesWithinDocumentBound(slice.content)) return false;
            invalid?.();
            return true;
          },
        },
        view(view) {
          const cancel = () => {
            const resize = columnResizingPluginKey.getState(view.state);
            if (resize?.dragging)
              view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null, setHandle: -1 }));
          };
          return {
            update(next, previous) {
              if (!next.editable || next.state.doc !== previous.doc) cancel();
            },
            destroy: cancel,
          };
        },
      }),
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
      return addRowAfter(editor.state, (transaction) => {
        const next = editor.state.apply(transaction);
        goToNextCell(1)(next, (navigation) => transaction.setSelection(navigation.selection));
        editor.view.dispatch(closeHistory(transaction));
      });
    };
    return { Tab: () => move(1), 'Shift-Tab': () => move(-1) };
  },
});
