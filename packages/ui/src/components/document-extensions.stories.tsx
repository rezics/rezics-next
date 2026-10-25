import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { DocumentBody } from './document-body.tsx';

const meta = { title: 'Rezics UI/Document Extensions', component: DocumentBody } satisfies Meta<typeof DocumentBody>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SharedSchema: Story = {
  args: {
    document: {
      version: 'rezics-document-v1',
      profile: 'text',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shared document schema' }] }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Shared document schema')).toBeVisible();
  },
};
