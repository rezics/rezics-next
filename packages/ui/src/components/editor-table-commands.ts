import { Extension, type Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { Command } from '@tiptap/pm/state';
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

export function runTableCommand(editor: Editor, name: TableCommandName, isCurrent: () => boolean): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return false;
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
