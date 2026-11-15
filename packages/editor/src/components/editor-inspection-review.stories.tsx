import { fromMarkdown, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { Extension } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { useEditor } from '@tiptap/react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { EditorFind, EditorFindHighlights } from './editor-find.tsx';
import { EditorOutline } from './editor-outline.tsx';
import { editorAttributes, editorExtensions, EditorSurface } from './editor-surface.ts';
import { editorWorkbenchLabels } from './editor-workbench-labels.ts';

/** Contract-shaped synthetic fixtures for presentation review; not recorded native documents. */
const longQuery = 'Supercalifragilisticexpialidocious'.repeat(8).slice(0, 256);
const unmatchedQuery = 'unmatched-inspection-query';
const longHeading =
  'A synthetic chapter title that keeps wrapping Supercalifragilisticexpialidocious headings for inspection review';
const nestedHeading =
  'Nested synthetic heading 星を越えて彼方の記憶をたどる旅 Supercalifragilisticexpialidocious';
const longQueryDocument = fromPlainText(`${longQuery}\n\nThe sea is quiet.`, 'blocks');
const emptyFindDocument = fromPlainText('The sea is quiet. The voyage continues.', 'blocks');
const longHeadingDocument = fromMarkdown(
  `# ${longHeading}\n\n## ${nestedHeading}\n\n### Supercalifragilisticexpialidocious\n\nA synthetic body paragraph.`,
  'blocks',
);
const emptyOutlineDocument = fromPlainText('A synthetic paragraph without headings.', 'blocks');

const History = Extension.create({
  name: 'inspectionReviewHistory',
  addProseMirrorPlugins: () => [history()],
});

function InspectionReview({
  value,
  panel,
  selectFirstText = false,
  defaultQuery,
}: {
  value: DocumentSnapshot;
  panel: 'find' | 'outline';
  selectFirstText?: boolean;
  defaultQuery?: string;
}) {
  const editor = useEditor({
    extensions: [History, EditorFindHighlights, ...editorExtensions(value.profile)],
    content: value.doc,
    injectCSS: false,
    immediatelyRender: false,
    editorProps: {
      attributes: editorAttributes({
        label: 'Synthetic inspection document',
        disabled: false,
        readOnly: false,
      }),
    },
    onCreate({ editor: instance }) {
      if (!selectFirstText) return;
      const block = instance.state.doc.firstChild;
      if (!block) return;
      instance.view.dispatch(
        instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 1, block.nodeSize - 1)),
      );
    },
  });
  if (!editor) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {panel === 'find' ? (
        <EditorFind
          editor={editor}
          labels={editorWorkbenchLabels}
          isCurrent={() => true}
          onClose={() => undefined}
          {...(defaultQuery === undefined ? {} : { defaultQuery })}
        />
      ) : (
        <EditorOutline editor={editor} labels={editorWorkbenchLabels} isCurrent={() => true} />
      )}
      <EditorSurface editor={editor} label="Synthetic inspection document" compact />
    </div>
  );
}

const meta = {
  title: 'Editor/Writing/Inspection',
  id: 'editor-inspection-review',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Actual Find/replace and Outline panels with contract-shaped synthetic documents. Review the same IDs with the viewport and theme toolbar; these entries do not fix a width or theme.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongQuery: Story = {
  name: 'Long query',
  render: () => <InspectionReview value={longQueryDocument} panel="find" selectFirstText />,
};

export const EmptyResults: Story = {
  name: 'Empty results',
  render: () => <InspectionReview value={emptyFindDocument} panel="find" defaultQuery={unmatchedQuery} />,
};

export const LongHeadingLabels: Story = {
  name: 'Long heading labels',
  render: () => <InspectionReview value={longHeadingDocument} panel="outline" />,
};

export const EmptyOutline: Story = {
  name: 'Empty outline',
  render: () => <InspectionReview value={emptyOutlineDocument} panel="outline" />,
};
