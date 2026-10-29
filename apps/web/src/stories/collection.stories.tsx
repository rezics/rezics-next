import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { m } from '../paraglide/messages.js';
import { pagePaths, pageReady, PageStory } from './page';

const meta = { title: 'Pages/Library/Collection details', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(
  mode: Parameters<typeof setCollectionStoryMode>[0],
  visitor: 'Signed In' | 'Signed Out' = 'Signed In',
  path = pagePaths['library-collection'],
) {
  setCollectionStoryMode(mode);
  return <PageStory visitor={visitor} path={path} credentialMode={visitor === 'Signed In' ? 'session' : 'anonymous'} />;
}

async function detailReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: 'Books I come back to' });
  return view;
}

export const Curator: Story = {
  name: 'Curator',
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('button', { name: m.library_collection_actions() });
    await view.findByRole('heading', { level: 2, name: m.library_collection_members() });
  },
};

export const PrivateCurator: Story = {
  name: 'Private collection, curator',
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_visibility_private(), { exact: true })).toBeVisible();
  },
};

export const PrivateNotFound: Story = {
  name: 'Private collection, other visitor',
  render: () => render('hidden', 'Signed Out'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnknownNotFound: Story = {
  name: 'Unknown collection',
  render: () => render('hidden', 'Signed Out', '/collections/00000000-0000-4000-8000-000000000000'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnlistedVisitor: Story = {
  name: 'Unlisted collection, direct visitor',
  render: () => render('unlisted', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.queryByRole('button', { name: m.library_collection_actions() })).toBeNull();
    await view.findByRole('link', { name: 'The Little Prince' });
  },
};

export const PublicVisitor: Story = {
  name: 'Public collection, visitor',
  render: () => render('public', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Tale of Genji' });
  },
};

export const Empty: Story = {
  name: 'Empty collection',
  render: () => render('empty'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_collection_empty())).toBeVisible();
  },
};

export const OnePage: Story = {
  name: 'One page',
  render: () => render('one-page'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const ManyPages: Story = {
  name: 'Many pages',
  render: () => render('many-pages'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: m.library_collection_more() });
  },
};

export const NotesAndDuplicates: Story = {
  name: 'Notes and duplicate occurrences',
  render: () => render('notes-duplicates'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByText('A second occurrence with its own note.');
    await expect(view.getAllByRole('link', { name: 'Snow Country' })).toHaveLength(2);
  },
};

export const Editing: Story = {
  name: 'Editing',
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await userEvent.click(await view.findByRole('button', { name: m.library_collection_actions() }));
    await userEvent.click(await within(document.body).findByRole('menuitem', { name: m.library_collection_edit() }));
    await view.findByRole('textbox', { name: m.library_collection_title() });
  },
};

export const Reordering: Story = {
  name: 'Reordering',
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    const first = await view.findByRole('link', { name: 'Snow Country' });
    const firstItem = first.closest('li');
    if (!firstItem) throw new Error('The first member is not in the ordered list.');
    await userEvent.click(within(firstItem).getByRole('button', { name: m.library_member_move_down() }));
    const items = view.getAllByRole('listitem');
    await expect(items[0]).toContainElement(view.getByRole('link', { name: 'The Tale of Genji' }));
  },
};

export const Following: Story = {
  name: 'Following a public collection',
  render: () => render('public-reader'),
  play: async (context) => {
    const view = await detailReady(context);
    const follow = await view.findByRole('button', { name: m.library_follow() });
    await userEvent.click(follow);
    await view.findByText(m.library_following(), { exact: true });
    await expect(view.getByRole('button', { name: m.library_follow_unfollow() })).toBeVisible();
  },
};

export const DeepPage: Story = {
  name: 'Deep page',
  render: () => render('deep-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-two`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Little Prince' });
  },
};

export const FinalPage: Story = {
  name: 'Final page',
  render: () => render('final-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-three`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Kokoro' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const Preparing: Story = {
  name: 'Preparing',
  render: () => render('preparing'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const RestartAfterEpochChange: Story = {
  name: 'Restart after cursor epoch changes',
  render: () => render('stale', 'Signed In', `${pagePaths['library-collection']}?cursor=old-epoch`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
  },
};
