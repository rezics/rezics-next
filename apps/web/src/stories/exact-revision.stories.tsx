import type { Meta, StoryObj } from '@storybook/react-vite';
import { ExactRevisionExample } from './exact-revision/example';
import { exactRevisionViewports, id, ready, selected } from './exact-revision/fixture';
import * as pattern from './exact-revision/exact-revision.stories';

const meta = {
  title: 'Pages/Community/Exact revision',
  component: ExactRevisionExample,
  parameters: { layout: 'fullscreen', viewport: { options: exactRevisionViewports } },
  args: { initial: ready, shell: true },
} satisfies Meta<typeof ExactRevisionExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedRevision: Story = { ...pattern.SelectedRevision };
export const Unavailable: Story = { ...pattern.Unavailable };
export const Loading: Story = { ...pattern.Loading };
export const NativeRetry: Story = { ...pattern.NativeRetry };
export const DifferentCurrentHead: Story = { ...pattern.DifferentCurrentHead };

export const DocumentMediaUnavailable: Story = {
  args: {
    initial: {
      ...ready,
      revision: {
        ...selected,
        mediaIds: [id(60)],
        body: {
          ...selected.body,
          doc: {
            ...selected.body.doc,
            content: [
              ...(selected.body.doc.content ?? []),
              { type: 'image', attrs: { id: 'edition-image', src: id(60), alt: 'A quiet reading room' } },
            ],
          },
        },
      },
    },
  },
};
