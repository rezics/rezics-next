import type { Editor } from '@tiptap/core';
import { redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import type { RichTextEditorLabels } from './editor-labels.ts';

export interface EditorCommand {
  id: string;
  label: keyof RichTextEditorLabels;
  node?: string;
  mark?: string;
  /** Extra words the slash menu matches besides the localized label. */
  keywords?: readonly string[];
  active?: (editor: Editor) => boolean;
  run: (editor: Editor, openLink: () => void, openImage?: () => void) => void;
}

/** Block identities survive a change of text block type. */
function carried(node: ProseMirrorNode): Record<string, unknown> {
  return Object.fromEntries(
    ['id', 'lang', 'dir', 'textAlign'].flatMap((key) => (node.attrs[key] != null ? [[key, node.attrs[key]]] : [])),
  );
}

function unwrapBlocks(editor: Editor) {
  for (let depth = editor.state.selection.$from.depth; depth > 0; depth--) {
    const lifted = editor.isActive('taskItem')
      ? editor.commands.liftListItem('taskItem')
      : editor.isActive('listItem')
        ? editor.commands.liftListItem('listItem')
        : editor.isActive('blockquote')
          ? editor.commands.lift('blockquote')
          : false;
    if (!lifted) break;
  }
}

function setTextblock(editor: Editor, type: string, attrs: Record<string, unknown> = {}) {
  unwrapBlocks(editor);
  editor
    .chain()
    .command(({ tr, state }) => {
      tr.setBlockType(state.selection.from, state.selection.to, state.schema.nodes[type]!, (node) => ({
        ...carried(node),
        ...attrs,
      }));
      return true;
    })
    .run();
}

const mark = (id: string, label: keyof RichTextEditorLabels): EditorCommand => ({
  id,
  label,
  mark: id,
  active: (editor) => editor.isActive(id),
  run: (editor) => {
    editor.chain().toggleMark(id).run();
  },
});

export const imageCommand: EditorCommand = {
  id: 'image',
  label: 'image',
  node: 'image',
  keywords: ['picture', 'photo', 'img'],
  run: (_editor, _openLink, openImage) => openImage?.(),
};

export const markCommands: readonly EditorCommand[] = [
  mark('bold', 'bold'),
  mark('italic', 'italic'),
  mark('strike', 'strike'),
  mark('code', 'inlineCode'),
  {
    id: 'link',
    label: 'link',
    mark: 'link',
    active: (editor) => editor.isActive('link'),
    run: (_editor, openLink) => openLink(),
  },
  {
    id: 'clearFormatting',
    label: 'clearFormatting',
    run: (editor) => {
      editor.chain().unsetAllMarks().run();
    },
  },
];

/** Inline formats kept on the touch bar. The selection menu can offer the full mark command set. */
export const touchBarFormatCommands: readonly EditorCommand[] = markCommands.filter((command) =>
  ['bold', 'italic', 'link', 'code'].includes(command.id),
);

export const undoCommand: EditorCommand = {
  id: 'undo',
  label: 'undo',
  run: (editor) => {
    undo(editor.state, (transaction) => editor.view.dispatch(transaction));
  },
};

export const redoCommand: EditorCommand = {
  id: 'redo',
  label: 'redo',
  run: (editor) => {
    redo(editor.state, (transaction) => editor.view.dispatch(transaction));
  },
};

const heading = (level: 1 | 2 | 3): EditorCommand => ({
  id: `heading${level}`,
  label: `heading${level}`,
  node: 'heading',
  keywords: [`h${level}`, 'heading', 'title'],
  active: (editor) => editor.isActive('heading', { level }),
  run: (editor) => setTextblock(editor, editor.isActive('heading', { level }) ? 'paragraph' : 'heading', { level }),
});
const list = (
  node: string,
  item: string,
  label: keyof RichTextEditorLabels,
  keywords: readonly string[],
): EditorCommand => ({
  id: node,
  label,
  node,
  keywords,
  active: (editor) => editor.isActive(node),
  run: (editor) => {
    if (editor.isActive('heading') || editor.isActive('codeBlock')) setTextblock(editor, 'paragraph');
    editor.chain().toggleList(node, item).run();
  },
});
export const blockCommands: readonly EditorCommand[] = [
  {
    id: 'paragraph',
    label: 'paragraph',
    node: 'paragraph',
    keywords: ['text', 'plain'],
    active: (editor) => editor.isActive('paragraph'),
    run: (editor) => setTextblock(editor, 'paragraph'),
  },
  heading(1),
  heading(2),
  heading(3),
  list('bulletList', 'listItem', 'bulletList', ['ul', 'bullet', 'list']),
  list('orderedList', 'listItem', 'orderedList', ['ol', 'numbered', 'list']),
  list('taskList', 'taskItem', 'taskList', ['todo', 'task', 'checkbox', 'checklist']),
  {
    id: 'blockquote',
    label: 'quote',
    node: 'blockquote',
    keywords: ['quote', 'blockquote', 'citation'],
    active: (editor) => editor.isActive('blockquote'),
    run: (editor) => {
      if (editor.isActive('heading') || editor.isActive('codeBlock')) setTextblock(editor, 'paragraph');
      editor.chain().toggleWrap('blockquote').run();
    },
  },
  {
    id: 'codeBlock',
    label: 'codeBlock',
    node: 'codeBlock',
    keywords: ['code', 'pre', 'snippet'],
    active: (editor) => editor.isActive('codeBlock'),
    run: (editor) => setTextblock(editor, editor.isActive('codeBlock') ? 'paragraph' : 'codeBlock'),
  },
];

/** A leaf block replaces an emptied paragraph; text before the slash keeps its block. */
function insertBlock(editor: Editor, content: Record<string, unknown>) {
  const block = editor.schema.nodeFromJSON(content);
  editor
    .chain()
    .command(({ tr, state }) => {
      const { $from } = state.selection;
      if (!$from.parent.isTextblock) return false;
      const paragraph = state.schema.nodes.paragraph?.createAndFill();
      const inserted = paragraph && !block.isTextblock ? Fragment.from([block, paragraph]) : block;
      const at = $from.parent.content.size === 0 ? $from.before() : $from.after();
      if ($from.parent.content.size === 0) tr.replaceWith($from.before(), $from.after(), inserted);
      else tr.insert($from.after(), inserted);
      const inside = at + block.nodeSize + (paragraph && !block.isTextblock ? 1 : 0);
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(inside, tr.doc.content.size))));
      return true;
    })
    .run();
}

const cell = (type: 'tableHeader' | 'tableCell') => ({ type, content: [{ type: 'paragraph' }] });
const tableRow = (type: 'tableHeader' | 'tableCell') => ({
  type: 'tableRow',
  content: [cell(type), cell(type), cell(type)],
});

export const horizontalRuleCommand: EditorCommand = {
  id: 'horizontalRule',
  label: 'horizontalRule',
  node: 'horizontalRule',
  keywords: ['hr', 'divider', 'rule', 'line'],
  run: (editor) => insertBlock(editor, { type: 'horizontalRule' }),
};

export const tableCommand: EditorCommand = {
  id: 'table',
  label: 'table',
  node: 'table',
  keywords: ['grid', 'rows', 'columns'],
  run: (editor) =>
    insertBlock(editor, {
      type: 'table',
      content: [tableRow('tableHeader'), tableRow('tableCell'), tableRow('tableCell')],
    }),
};

/** Blocks the slash menu can insert. Image stays in the set and is offered only when an upload exists. */
export const insertCommands: readonly EditorCommand[] = [
  ...blockCommands.filter((command) => command.id !== 'paragraph'),
  horizontalRuleCommand,
  tableCommand,
  imageCommand,
];

/** Slash can also start an inline link while keeping the block insertion set separate for the touch sheet. */
export const slashCommands: readonly EditorCommand[] = [
  ...insertCommands,
  markCommands.find((command) => command.id === 'link')!,
];

/** Schema membership, rather than a profile flag, determines the offered commands. */
export function availableCommands(commands: readonly EditorCommand[], editor: Editor) {
  return commands.filter(
    (command) =>
      (!command.node || editor.schema.nodes[command.node]) && (!command.mark || editor.schema.marks[command.mark]),
  );
}

/** The touch sheet uses the insertion set and schema/upload rules offered by the slash menu. */
export function availableInsertCommands(editor: Editor, upload: boolean): EditorCommand[] {
  return availableCommands(insertCommands, editor).filter((command) => command.id !== 'image' || upload);
}

/** Run a menu command only from its current editable visit, then focus synchronously if that visit still owns it. */
export function runEditorCommand(
  command: EditorCommand,
  editor: Editor,
  openLink: () => void,
  openImage: () => void,
  isCurrent: () => boolean,
): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return false;
  command.run(editor, openLink, openImage);
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return true;
  editor.view.focus();
  return true;
}

/** A constant set of commands is recomputed once per transaction. */
export function useCommandState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const blocks = availableCommands(blockCommands, current).map((command) => ({
        command,
        active: command.active?.(current) ?? false,
      }));
      const selectedBlock =
        blocks.find(({ command, active }) => command.id !== 'paragraph' && active)?.command.id ?? 'paragraph';
      return {
        empty: current.state.selection.empty,
        canUndo: undoDepth(current.state) > 0,
        canRedo: redoDepth(current.state) > 0,
        marks: availableCommands(markCommands, current).map((command) => ({
          command,
          active: command.active?.(current) ?? false,
        })),
        blocks: blocks.map(({ command }) => ({ command, active: command.id === selectedBlock })),
      };
    },
  });
}
