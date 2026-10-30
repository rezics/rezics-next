import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionBrowseRow, CollectionCopyMenu, type CollectionBrowseRecord } from '../library/collection-browser';
import { subjectOf } from '../library/reads';
import memberPage from '../kernel/recorded/library-collection-members.json';
import recording from '../kernel/recorded/library-collection.json';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Collection Row',
  tags: ['autodocs'],
  excludeStories: ['recordedBrowseCollection'],
  parameters: {
    docs: {
      description: {
        component:
          'One Collection, its disclosed native total and a single Open action. The current list source does not yet provide covers or member previews; recorded member data here demonstrates the shared presentation without extra reads.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export function recordedBrowseCollection(): CollectionBrowseRecord {
  return {
    ...recording.collection,
    curator: recording.collection.curator,
    preview: { state: 'loaded', members: memberPage.members.map((member) => subjectOf(member.subject)!) },
  };
}

function renderCollection(visibility: 'public' | 'private', empty = false) {
  const collection: CollectionBrowseRecord = {
    ...recordedBrowseCollection(),
    visibility,
    ...(empty ? { memberCount: 0, preview: { state: 'loaded', members: [] } } : {}),
  };
  return (
    <PatternStory>
      <ul className="w-full p-4">
        <CollectionBrowseRow
          collection={collection}
          menu={
            <CollectionCopyMenu
              title={collection.title!}
              onCopy={() => navigator.clipboard.writeText(`${location.origin}/collections/${collection.id}`)}
            />
          }
        />
      </ul>
    </PatternStory>
  );
}

export const Public: Story = {
  render: () => renderCollection('public'),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('link', { name: m.library_collection_open() })).toBeVisible();
    await expect(within(canvasElement).getByText(m.library_collection_item_count({ count: 4 }))).toBeVisible();
  },
};
export const Private: Story = {
  render: () => renderCollection('private'),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.library_visibility_private())).toBeVisible();
  },
};
export const Empty: Story = {
  render: () => renderCollection('public', true),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.library_collection_item_count({ count: 0 }))).toBeVisible();
  },
};
export const MenuOpen: Story = {
  render: () => renderCollection('public'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: `${m.library_collection_actions()}: ${recording.collection.title}` }),
    );
    await expect(await within(document.body).findByText(m.library_collection_copy(), { exact: true })).toBeVisible();
  },
};
