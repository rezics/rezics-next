import {
  documentVersion,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Editor, JSONContent } from '@tiptap/core';
import { useEditor } from '@tiptap/react';
import { useState } from 'react';
import { productControlLabels } from './editor-upstream/reactjs-tiptap-editor/control-labels.ts';
import { TableInsert } from './editor-upstream/reactjs-tiptap-editor/create-table.tsx';
import { TableControls } from './editor-upstream/reactjs-tiptap-editor/table-controls.tsx';
import { tableControlLabels } from './editor-upstream/reactjs-tiptap-editor/table-labels.ts';
import { richTextEditorLabels, type RichTextEditorLabels } from './editor-labels.ts';
import { editorAttributes, EditorSurface, editorExtensions } from './editor-surface.ts';

const paragraph = (id: string, text: string): DocumentNode => ({
  type: 'paragraph',
  attrs: { id },
  content: text ? [{ type: 'text', text }] : [],
});

/** Contract-shaped synthetic snapshot: empty blocks document for table insertion. */
const emptyBlocks = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({ type: 'doc', content: [paragraph('lead', '')] }),
});

/** Contract-shaped synthetic snapshot: 2×2 table with the caret placed in the first cell. */
const tableDocument = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      {
        type: 'table',
        attrs: { id: 'table' },
        content: Array.from({ length: 2 }, (_, row) => ({
          type: 'tableRow',
          attrs: { id: `row-${row}` },
          content: Array.from({ length: 2 }, (_, col) => ({
            type: 'tableCell',
            attrs: { id: `cell-${row}-${col}` },
            content: [paragraph(`cell-body-${row}-${col}`, `${row + 1},${col + 1}`)],
          })),
        })),
      },
    ],
  }),
});

const overflowMark = ' — localized overflow review';

/** Current product labels, lengthened as a synthetic overflow fixture. */
const longTranslatedLabels: RichTextEditorLabels = {
  ...richTextEditorLabels,
  table: `${richTextEditorLabels.table}${overflowMark}`,
  cancel: `${richTextEditorLabels.cancel}${overflowMark}`,
  ...Object.fromEntries(Object.entries(productControlLabels).map(([key, value]) => [key, `${value}${overflowMark}`])),
  ...Object.fromEntries(Object.entries(tableControlLabels).map(([key, value]) => [key, `${value}${overflowMark}`])),
};

function placeCaretInFirstCell(editor: Editor) {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null || node.type.name !== 'paragraph') return;
    const $pos = editor.state.doc.resolve(pos + 1);
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === 'tableCell') {
        found = pos + 1;
        return false;
      }
    }
  });
  if (found !== null) editor.commands.setTextSelection(found);
}

function ReviewNote({ children }: { children: string }) {
  return <p className="mb-3 min-w-0 text-sm leading-snug text-muted-foreground break-words">{children}</p>;
}

function TableCreationReview() {
  const [open, setOpen] = useState(true);
  const editor = useEditor({
    extensions: editorExtensions('blocks'),
    content: emptyBlocks.doc as JSONContent,
    immediatelyRender: false,
    injectCSS: false,
    editable: true,
    editorProps: {
      attributes: editorAttributes({ label: 'Chapter draft', disabled: false, readOnly: false }),
    },
  });
  if (!editor) return null;
  return (
    <div className="min-w-0 max-w-full">
      <ReviewNote>
        Synthetic overflow fixture: current table-creation labels lengthened for narrow-width review.
      </ReviewNote>
      <EditorSurface editor={editor} label="Chapter draft" compact />
      {open ? (
        <TableInsert
          editor={editor}
          labels={longTranslatedLabels}
          target={{ doc: editor.state.doc, selection: editor.state.selection }}
          isCurrent={() => !editor.isDestroyed && editor.isEditable}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function TableActionsReview() {
  const editor = useEditor({
    extensions: editorExtensions('blocks'),
    content: tableDocument.doc as JSONContent,
    immediatelyRender: false,
    injectCSS: false,
    editable: true,
    editorProps: {
      attributes: editorAttributes({ label: 'Chapter draft', disabled: false, readOnly: false }),
    },
    onCreate: ({ editor: current }) => {
      placeCaretInFirstCell(current);
    },
  });
  if (!editor) return null;
  return (
    <div className="min-w-0 max-w-full">
      <ReviewNote>
        Synthetic overflow fixture: current table-action labels lengthened for narrow-width review.
      </ReviewNote>
      <TableControls
        editor={editor}
        labels={longTranslatedLabels}
        labelOverrides={longTranslatedLabels}
        isCurrent={() => !editor.isDestroyed && editor.isEditable}
      />
      <EditorSurface editor={editor} label="Chapter draft" compact />
    </div>
  );
}

const meta = {
  id: 'editor-tables-review',
  title: 'Editor/Writing/Tables',
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="min-w-0 bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const CreationLongTranslatedLabels: Story = {
  name: 'Creation, long translated labels',
  render: () => <TableCreationReview />,
};

export const ActionsLongTranslatedLabels: Story = {
  name: 'Actions, long translated labels',
  render: () => <TableActionsReview />,
};
