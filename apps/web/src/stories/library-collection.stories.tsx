import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { PageStory, libraryCollectionReady, pagePaths, pageReady } from './page';
import { collectionStoryPaths } from '../kernel/fake/collection-stories';

const meta = { title: 'Pages/Library/Collection', parameters: { layout: 'fullscreen' } } satisfies Meta;
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
  if (title) await within(context.canvasElement).findByRole('heading', { level: 1, name: title });
}

async function collectionReadyWithHover(context: { canvasElement: HTMLElement }) {
  await libraryCollectionReady(context);
  const row = (await within(context.canvasElement).findAllByRole('listitem'))[0];
  if (row) await userEvent.hover(row);
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

export const CuratorPublicMany = variantStory(variants.CuratorPublicMany);
export const ReaderPublicMany = variantStory(variants.ReaderPublicMany);
export const CuratorPrivateEmpty = variantStory(variants.CuratorPrivateEmpty);
export const ReaderPrivate = variantStory(variants.ReaderPrivate);
export const CuratorPublicOnePage = variantStory(variants.CuratorPublicOnePage);
