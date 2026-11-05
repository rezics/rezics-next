import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { collectionPageQuery, readCollectionPage } from '../library/collection-queries';
import { CollectionPage } from '../library/collection-page';
import { setCollectionStoryMode, type CollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = { title: 'Patterns/Library/Collection controls' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const collectionId = pagePaths['library-collection'].split('/').at(-1)!;

function CollectionRegion({ visitor }: { visitor: 'Signed In' | 'Signed Out' }) {
  const credentialMode = visitor === 'Signed In' ? 'session' : 'anonymous';
  const query = collectionPageQuery(collectionId, undefined, credentialMode);
  const { data } = useSuspenseQuery(query);
  if ('preparing' in data) return null;
  return (
    <CollectionPage
      page={data}
      cursor={undefined}
      layout="list"
      queryKey={query.queryKey}
      refreshPage={async () => {
        const refreshed = await readCollectionPage({
          data: { id: collectionId, credentialMode },
        });
        if ('preparing' in refreshed) throw new Error('Expected a curated collection page');
        return refreshed;
      }}
    />
  );
}

function renderCollection(mode: CollectionStoryMode, visitor: 'Signed In' | 'Signed Out' = 'Signed In') {
  setCollectionStoryMode(mode);
  return (
    <PatternStory visitor={visitor} path={pagePaths['library-collection']}>
      <Suspense fallback={null}>
        <div className="w-full p-4">
          <CollectionRegion visitor={visitor} />
        </div>
      </Suspense>
    </PatternStory>
  );
}

async function collectionReady(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await view.findByRole('heading', { level: 1, name: 'Books I come back to' });
  return view;
}

export const EditFormOpen: Story = {
  name: 'Owner, collection edit form open',
  play: async ({ canvasElement }) => {
    const view = await collectionReady(canvasElement);
    await userEvent.click(view.getAllByRole('button', { name: m.library_collection_actions() })[0]!);
    await userEvent.click(await within(document.body).findByText(m.library_collection_edit(), { exact: true }));
    await view.findByRole('textbox', { name: m.library_collection_title() });
  },
  render: () => renderCollection('private'),
};

export const MembersReordered: Story = {
  name: 'Owner, members reordered',
  play: async ({ canvasElement }) => {
    const view = await collectionReady(canvasElement);
    await userEvent.click(view.getAllByRole('button', { name: m.library_collection_actions() })[0]!);
    await userEvent.click(await within(document.body).findByText(m.library_collection_edit(), { exact: true }));
    const first = await view.findByRole('link', { name: 'Snow Country' });
    const firstItem = first.closest('li');
    if (!firstItem) throw new Error('The first member is not in the ordered list.');
    await userEvent.click(
      within(firstItem).getByRole('button', {
        name: m.library_member_move_down(),
      }),
    );
    const items = view.getAllByRole('listitem');
    await expect(items[0]).toContainElement(view.getByRole('link', { name: 'The Tale of Genji' }));
  },
  render: () => renderCollection('private'),
};

export const FollowingEnabled: Story = {
  name: 'Member, following a public collection',
  play: async ({ canvasElement }) => {
    const view = await collectionReady(canvasElement);
    const follow = await view.findByRole('button', {
      name: m.library_follow(),
    });
    await userEvent.click(follow);
    await view.findByText(m.library_following(), { exact: true });
    await expect(view.getByRole('button', { name: m.library_follow_unfollow() })).toBeVisible();
  },
  render: () => renderCollection('public-reader'),
};
