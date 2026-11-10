import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CollectionPreview, type CollectionBrowseRecord } from '../library/collection-browser';
import { recordedBrowseCollection } from './library-collection-row.stories';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Collection Preview',
  id: 'patterns-collection-preview',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A bounded strip of the first three actual members, in source order. An unavailable preview is distinct from a proven empty Collection. The native preview transport is still unavailable in this checkout; these recorded members exercise only the presentation boundary.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function renderPreview(state: 'members' | 'empty' | 'unavailable' | 'preparing') {
  const collection: CollectionBrowseRecord = recordedBrowseCollection();
  if (state === 'empty') {
    collection.memberCount = 0;
    collection.preview = { state: 'loaded', members: [] };
  }
  if (state === 'unavailable') collection.preview = { state: 'unavailable' };
  if (state === 'preparing') collection.preview = { state: 'preparing' };
  return (
    <PatternStory>
      <div className="w-full p-4">
        <CollectionPreview collection={collection} />
      </div>
    </PatternStory>
  );
}

export const Members: Story = {
  render: () => renderPreview('members'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: 'Snow Country' });
    await expect(canvas.queryByRole('link', { name: 'Kokoro' })).toBeNull();
  },
};
export const Empty: Story = {
  render: () => renderPreview('empty'),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(m.library_collection_empty())).toBeVisible();
  },
};
export const Unavailable: Story = {
  render: () => renderPreview('unavailable'),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent(
      m.library_collection_preview_unavailable(),
    );
  },
};

export const Preparing: Story = {
  render: () => renderPreview('preparing'),
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveTextContent(m.library_collection_preview_preparing());
    await expect(within(canvasElement).queryByText(m.library_collection_empty())).toBeNull();
  },
};
