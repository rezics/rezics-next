import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setCollectionStoryMode } from '../kernel/fake/collection-page-stories';
import { m } from '../paraglide/messages.js';
import { pagePaths, pageReady, PageStory } from './page';

const meta = {
  title: 'Pages/Library/Collection',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
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
  name: 'Owner, private collection',
  tags: ['!dev'],
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('button', { name: m.library_collection_actions() });
    await view.findByRole('heading', {
      level: 2,
      name: m.library_collection_members(),
    });
  },
};

export const PrivateCurator: Story = {
  name: 'Owner, private visibility',
  tags: ['!dev'],
  render: () => render('private'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_visibility_private(), { exact: true })).toBeVisible();
  },
};

export const PrivateNotFound: Story = {
  name: 'Signed out, private collection unavailable',
  tags: ['!dev'],
  render: () => render('hidden', 'Signed Out'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnknownNotFound: Story = {
  name: 'Signed out, unknown collection',
  tags: ['!dev'],
  render: () => render('hidden', 'Signed Out', '/collections/00000000-0000-4000-8000-000000000000'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const UnlistedVisitor: Story = {
  name: 'Signed out, unlisted collection',
  tags: ['!dev'],
  render: () => render('unlisted', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.queryByRole('button', { name: m.library_collection_actions() })).toBeNull();
    await expect(view.getByText(m.library_member_count({ count: 0 }))).toBeVisible();
    await expect(view.getByText(m.library_collection_empty())).toBeVisible();
    await expect(view.queryByRole('link', { name: 'The Little Prince' })).toBeNull();
    await expect(context.canvasElement.ownerDocument.querySelector('script[type="application/ld+json"]')).toBeNull();
  },
};

export const PublicVisitor: Story = {
  name: 'Signed out, public collection',
  tags: ['!dev'],
  render: () => render('public', 'Signed Out'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Tale of Genji' });
  },
};

export const Empty: Story = {
  name: 'Owner, empty collection',
  tags: ['!dev'],
  render: () => render('empty'),
  play: async (context) => {
    const view = await detailReady(context);
    await expect(view.getByText(m.library_collection_empty())).toBeVisible();
  },
};

export const OnePage: Story = {
  name: 'Owner, one page of members',
  tags: ['!dev'],
  render: () => render('one-page'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const ManyPages: Story = {
  name: 'Owner, multiple pages of members',
  tags: ['!dev'],
  render: () => render('many-pages'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: m.library_collection_more() });
  },
};

export const NotesAndDuplicates: Story = {
  name: 'Owner, duplicate members with notes',
  tags: ['!dev'],
  render: () => render('notes-duplicates'),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByText('A second occurrence with its own note.');
    await view.findByText(m.library_member_count({ count: 5 }), {
      exact: true,
    });
    await expect(view.getAllByRole('link', { name: 'Snow Country' })).toHaveLength(2);
  },
};

export const DeepPage: Story = {
  name: 'Owner, deeper members',
  tags: ['!dev'],
  render: () => render('deep-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-two`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'The Little Prince' });
  },
};

export const FinalPage: Story = {
  name: 'Owner, last members',
  tags: ['!dev'],
  render: () => render('final-page', 'Signed In', `${pagePaths['library-collection']}?cursor=page-three`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Kokoro' });
    await expect(view.queryByRole('link', { name: m.library_collection_more() })).toBeNull();
  },
};

export const Preparing: Story = {
  name: 'Owner, page unavailable',
  tags: ['!dev'],
  render: () => render('preparing'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const RestartAfterEpochChange: Story = {
  name: 'Owner, refreshed member list',
  tags: ['!dev'],
  render: () => render('stale', 'Signed In', `${pagePaths['library-collection']}?cursor=old-epoch`),
  play: async (context) => {
    const view = await detailReady(context);
    await view.findByRole('link', { name: 'Snow Country' });
  },
};
