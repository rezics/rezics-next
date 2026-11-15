import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { richTextEditorLabels } from './editor-labels.ts';
import {
  EditorMediaPropertiesDialog,
  type EditorMediaPropertiesDraft,
} from './editor-media-views.tsx';

/** Contract-shaped synthetic occurrence drafts for review; not stored media or an authorized upload. */
const longAlt: EditorMediaPropertiesDraft = {
  alt: 'Synthetic admitted landscape: a river in the foreground, hillside trees, and a distant ridge that would overflow a single-line alt control at the toolbar width.',
  title: 'Synthetic fixture title',
  width: '240',
  height: '120',
  conceal: false,
  caption: '',
};
const invalidDimensions: EditorMediaPropertiesDraft = {
  alt: 'Synthetic admitted landscape',
  title: '',
  width: '0',
  height: '-12',
  conceal: false,
  caption: '',
};
const longCaption: EditorMediaPropertiesDraft = {
  alt: '',
  title: '',
  width: '',
  height: '',
  conceal: false,
  caption:
    'Synthetic caption for the unavailable audio fixture. It wraps across several lines so the labelled control stays readable when the reviewer uses the toolbar width.',
};

function PropertiesReview({ image, draft }: { image: boolean; draft: EditorMediaPropertiesDraft }) {
  const [value, setValue] = useState(draft);
  const composing = useRef(false);
  const touched = useRef({ alt: false, title: false });
  return (
    <EditorMediaPropertiesDialog
      image={image}
      labels={richTextEditorLabels}
      draft={value}
      onDraftChange={setValue}
      composing={composing}
      touched={touched}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />
  );
}

const meta = {
  title: 'Editor/Media controls',
  id: 'editor-media-controls',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongAltText: Story = {
  name: 'Long alt text',
  render: () => <PropertiesReview image draft={longAlt} />,
};
export const InvalidDimensions: Story = {
  name: 'Invalid dimensions',
  render: () => <PropertiesReview image draft={invalidDimensions} />,
};
export const LongCaption: Story = {
  name: 'Long caption',
  render: () => <PropertiesReview image={false} draft={longCaption} />,
};
