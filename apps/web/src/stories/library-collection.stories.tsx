import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, libraryCollectionReady, pagePaths, pageReady } from './page';
import { collectionStoryPaths } from '../kernel/fake/collection-stories';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Collection',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Read page states. Review these same IDs at phone390 and desktop1280, all launch locale globals and light/dark theme globals. Web story review and Root screenshot review PENDING. Social actions and FULL facts await their native producers.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const variants = {
  CuratorPublicMany: {
    id: collectionStoryPaths.curatorPublicMany,
    title: 'A curator’s reading shelf',
    visitor: 'Signed In',
  },
  ReaderPublicMany: {
    id: collectionStoryPaths.readerPublicMany,
    title: 'A reader’s reading shelf',
    visitor: 'Signed Out',
    memberCount: 4,
  },
  CuratorPrivateEmpty: {
    id: collectionStoryPaths.curatorPrivateEmpty,
    title: 'A private empty shelf',
    visitor: 'Signed In',
  },
  ReaderPrivate: {
    id: collectionStoryPaths.readerPrivate,
    title: null,
    visitor: 'Signed Out',
  },
  CuratorPublicOnePage: {
    id: collectionStoryPaths.curatorPublicOnePage,
    title: 'A one-page shelf',
    visitor: 'Signed In',
  },
} as const;

async function variantReady(context: { canvasElement: HTMLElement }, title: string | null) {
  await pageReady(context);
  if (title)
    await within(context.canvasElement).findByRole('heading', {
      level: 1,
      name: title,
    });
}

async function collectionReadyWithHover(context: { canvasElement: HTMLElement }) {
  await libraryCollectionReady(context);
  const member = context.canvasElement.querySelector('[data-slot="collection-member-card"], [data-slot="list-row"]');
  if (member) await userEvent.hover(member);
}

function variantStory(variant: (typeof variants)[keyof typeof variants]): Story {
  return {
    play: (context) => variantReady(context, variant.title),
    render: () => <PageStory visitor={variant.visitor} path={`/collections/${variant.id}`} />,
  };
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: collectionReadyWithHover,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-collection']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: libraryCollectionReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-collection']} />,
};
export const PublicItemListExport: Story = {
  name: 'Public ItemList export',
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-collection']} />,
  play: async (context) => {
    await libraryCollectionReady(context);
    const document = context.canvasElement.ownerDocument;
    await waitFor(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const itemList = JSON.parse(script?.textContent ?? 'null') as {
        '@context'?: string;
        '@type'?: string;
        itemListElement?: unknown[];
      };
      expect(itemList).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'ItemList',
      });
      expect(itemList.itemListElement).toHaveLength(4);
      expect(JSON.stringify(itemList)).not.toMatch(/private|visibility|revision|curatorAccountId/i);
    });
  },
};

export const CuratorPublicMany = variantStory(variants.CuratorPublicMany);
export const GridLayout: Story = {
  name: 'Grid Layout',
  play: collectionReadyWithHover,
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.CuratorPublicMany.id}?layout=grid`} />,
};
export const ReaderPublicMany: Story = {
  ...variantStory(variants.ReaderPublicMany),
  play: async (context) => {
    await variantReady(context, variants.ReaderPublicMany.title);
    await expect(
      within(context.canvasElement).queryByText(
        m.library_member_count({
          count: variants.ReaderPublicMany.memberCount,
        }),
      ),
    ).toBeNull();
  },
};
export const CuratorPrivateEmpty = variantStory(variants.CuratorPrivateEmpty);
export const ReaderPrivate = variantStory(variants.ReaderPrivate);
export const CuratorPublicOnePage = variantStory(variants.CuratorPublicOnePage);

export const OwnerMenu: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.CuratorPublicMany.id}`} />,
  play: async (context) => {
    await variantReady(context, variants.CuratorPublicMany.title);
    const canvas = within(context.canvasElement);
    await expect(canvas.queryByRole('textbox', { name: m.library_collection_title() })).toBeNull();
    await expect(canvas.getByRole('button', { name: m.reaction_like() })).toBeDisabled();
    const menu = canvas.getByRole('button', { name: m.library_collection_actions() });
    await userEvent.click(menu);
    const body = within(context.canvasElement.ownerDocument.body);
    await expect(await body.findByText(m.library_collection_edit(), { exact: true })).toBeVisible();
    await expect(body.getByText(m.report_action(), { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu).toHaveFocus());
  },
};

export const MixedTypes: Story = {
  render: () => <PageStory visitor="Signed In" path="/collections/collection-read-mixed" />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-slot="member-list-row-title"]')).toHaveLength(4),
    );
    await expect(within(context.canvasElement).queryByText(/Type:/)).toBeNull();
    const rowMenu = within(context.canvasElement).getAllByRole('button', {
      name: new RegExp(`${m.library_collection_actions()}:`),
    })[0]!;
    await userEvent.click(rowMenu);
    await expect(
      await within(context.canvasElement.ownerDocument.body).findByText(m.library_collection_copy(), { exact: true }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

export const MembersPreparing: Story = {
  name: 'Members preparing',
  render: () => <PageStory visitor="Signed In" path="/collections/collection-read-preparing" />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_preparing())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
  },
};

export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/collections/collection-read-unavailable" />,
  play: async (context) => {
    await variantReady(context, 'A collection across many kinds of work');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.library_collection_empty())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_reload() }));
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
  },
};

export const Error: Story = {
  render: () => <PageStory visitor="Signed Out" path="/collections/collection-read-error" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.error_message())).toBeVisible();
    await expect(within(context.canvasElement).queryByText(m.library_collection_empty())).toBeNull();
  },
};

export const AnotherReader: Story = {
  render: () => <PageStory visitor="Signed In" path={`/collections/${variants.ReaderPublicMany.id}`} />,
  play: async (context) => {
    await variantReady(context, variants.ReaderPublicMany.title);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_actions() }));
    const body = within(context.canvasElement.ownerDocument.body);
    await expect(await body.findByText(m.report_action(), { exact: true })).toBeVisible();
    await expect(body.queryByText(m.library_collection_edit(), { exact: true })).toBeNull();
    await userEvent.keyboard('{Escape}');
  },
};
