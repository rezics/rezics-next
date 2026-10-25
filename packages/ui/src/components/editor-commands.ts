import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { useEditorState } from '@tiptap/react';
import type { RichTextEditorLabels } from './editor-labels.ts';

export interface EditorCommand {
  id: string;
  label: keyof RichTextEditorLabels;
  node?: string;
  mark?: string;
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
    .focus()
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
    editor.chain().focus().toggleMark(id).run();
  },
});

export const imageCommand: EditorCommand = {
  id: 'image',
  label: 'image',
  node: 'image',
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
      editor.chain().focus().unsetAllMarks().run();
    },
  },
];

const heading = (level: 1 | 2 | 3): EditorCommand => ({
  id: `heading${level}`,
  label: `heading${level}`,
  node: 'heading',
  active: (editor) => editor.isActive('heading', { level }),
  run: (editor) => setTextblock(editor, editor.isActive('heading', { level }) ? 'paragraph' : 'heading', { level }),
});
const list = (node: string, item: string, label: keyof RichTextEditorLabels): EditorCommand => ({
  id: node,
  label,
  node,
  active: (editor) => editor.isActive(node),
  run: (editor) => {
    if (editor.isActive('heading') || editor.isActive('codeBlock')) setTextblock(editor, 'paragraph');
    editor.chain().focus().toggleList(node, item).run();
  },
});
export const blockCommands: readonly EditorCommand[] = [
  {
    id: 'paragraph',
    label: 'paragraph',
    node: 'paragraph',
    active: (editor) => editor.isActive('paragraph'),
    run: (editor) => setTextblock(editor, 'paragraph'),
  },
  heading(1),
  heading(2),
  heading(3),
  list('bulletList', 'listItem', 'bulletList'),
  list('orderedList', 'listItem', 'orderedList'),
  list('taskList', 'taskItem', 'taskList'),
  {
    id: 'blockquote',
    label: 'quote',
    node: 'blockquote',
    active: (editor) => editor.isActive('blockquote'),
    run: (editor) => {
      if (editor.isActive('heading') || editor.isActive('codeBlock')) setTextblock(editor, 'paragraph');
      editor.chain().focus().toggleWrap('blockquote').run();
    },
  },
  {
    id: 'codeBlock',
    label: 'codeBlock',
    node: 'codeBlock',
    active: (editor) => editor.isActive('codeBlock'),
    run: (editor) => setTextblock(editor, editor.isActive('codeBlock') ? 'paragraph' : 'codeBlock'),
  },
];

/** Schema membership, rather than a profile flag, determines the offered commands. */
export function availableCommands(commands: readonly EditorCommand[], editor: Editor) {
  return commands.filter(
    (command) =>
      (!command.node || editor.schema.nodes[command.node]) && (!command.mark || editor.schema.marks[command.mark]),
  );
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
        marks: availableCommands(markCommands, current).map((command) => ({
          command,
          active: command.active?.(current) ?? false,
        })),
        blocks: blocks.map(({ command }) => ({ command, active: command.id === selectedBlock })),
      };
    },
  });
}
