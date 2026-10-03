import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import {
  chinese,
  classics,
  games,
  guides,
  memoryReaderActions,
  recipes,
  storyWorkId,
} from './fixtures.ts';
import {
  RateWork,
  type ReaderActions,
  ReaderActionsProvider,
  ShelfButton,
} from './reader-actions.tsx';
import { WorkRow } from './work-row.tsx';
import { WorkGrid, WorkShelf } from './work-shelf.tsx';

type Args = ComponentProps<typeof WorkShelf> & { actions?: ReaderActions; signedIn?: boolean };

const signInHref = '/auth/start?next=%2Fen%2Fdiscover';

const meta = {
  title: 'Catalogue/Shelves and cards',
  component: WorkShelf,
  parameters: {
    docs: {
      description: {
        component:
          'Cover-first shelves and cards shared by Discover, Search, the Work page and the home feed: covers without a card frame, the title in the Work-title face, authors in grey, `★ 4.26 · 41.9K`, and one shelf action on the cover. Reader actions come through a typed seam; without Main’s reader state (G-285) a signed-in reader sees no control rather than a dead one.',
      },
    },
  },
  args: {
    heading: { title: 'Readers’ favorites', seeAll: { href: '/discover?type=book' } },
    works: classics,
    locale: 'en',
  },
  render: ({ actions, signedIn = false, ...args }: Args) => (
    <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref} actions={actions}>
      <PageContainer>
        <WorkShelf {...args} />
      </PageContainer>
    </ReaderActionsProvider>
  ),
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadersFavorites: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const shelf = canvas.getByRole('region', { name: 'Readers’ favorites' });
    await expect(within(shelf).getByRole('link', { name: 'Pride and Prejudice' })).toHaveAttribute(
      'href',
      localizedPath(resourceHref('/w/', storyWorkId(1).slice(-36)), 'en'),
    );
    await expect(within(shelf).getByRole('link', { name: 'Jane Austen' })).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A',
    );
    within(shelf).getByRole('link', { name: 'Pride and Prejudice' }).focus();
    await userEvent.tab();
    await expect(within(shelf).getByRole('link', { name: 'Jane Austen' })).toHaveFocus();
    // The name is set on the generated cover too; the grey line under the title is the last.
    await expect(within(shelf).getAllByText('Jane Austen').at(-1)).toBeVisible();
    await expect(
      within(shelf).getByText('Average rating 4.29 out of 5, 4,391,220 ratings'),
    ).toBeInTheDocument();
    await expect(within(shelf).getAllByText('· 4.4M')[0]).toBeVisible();
    // A tagline sits under the title, as KadoKado sets one.
    await expect(
      within(shelf).getByText('A wry comedy of manners, first impressions and second thoughts.'),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'See all' })).toHaveAttribute(
      'href',
      '/en/discover?type=book',
    );
    // Signed out, the cover's shelf control leads to sign-in.
    await expect(
      within(shelf).getAllByRole('link', { name: 'Sign in to keep a reading list' })[0],
    ).toHaveAttribute('href', signInHref);
    const next = canvas.getByRole('button', { name: 'Next' });
    await expect(canvas.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(next);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Previous' })).toBeEnabled());
  },
};

/** Signed in with Main's reader state: the corner control shelves a Work in one menu. */
export const ShelvingFromACover: Story = {
  args: { actions: memoryReaderActions({ [storyWorkId(2)]: { status: 'read' } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Shelve “Pride and Prejudice”' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Currently reading' }));
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: 'Shelve “Pride and Prejudice” · Currently reading' }),
      ).toHaveAttribute('data-shelved'),
    );
    await expect(canvas.getByRole('button', { name: 'Shelve “Jane Eyre” · Read' })).toBeVisible();
  },
};

/** Signed in before Main has reader shelves: no control is drawn rather than one that does nothing. */
export const SignedInWithoutShelves: Story = {
  args: { signedIn: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: /Shelve/ })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Sign in to keep a reading list' })).toBeNull();
  },
};

/** Main denied this Agent a reader library: controls withdraw rather than fail on every press. */
export const LibraryDenied: Story = {
  args: { signedIn: true, actions: memoryReaderActions({}, { denied: true }) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('button', { name: /Shelve/ })).toBeNull();
  },
};

/** A shelf of one kind uses that kind's proportions: posters for documents, square cards for recipes. */
export const DocumentsAndRecipes: Story = {
  render: ({ actions, signedIn = false, ...args }: Args) => (
    <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref} actions={actions}>
      <PageContainer className="grid gap-12">
        <WorkShelf {...args} heading={{ title: 'Guides and references' }} works={guides} />
        <WorkShelf {...args} heading={{ title: 'Recipes to try' }} works={recipes} />
      </PageContainer>
    </ReaderActionsProvider>
  ),
};

/** A VideoGame wears the registry's landscape cover, not a book's. */
export const Games: Story = {
  args: { heading: { title: 'Visual novels and games' }, works: games },
  async play({ canvasElement }) {
    const covers = canvasElement.querySelectorAll<HTMLElement>('[data-slot="work-cover"]');
    await expect(covers.length).toBe(games.length);
    for (const cover of covers) {
      await expect(cover.dataset.kind).toBe('game');
      const box = cover.getBoundingClientRect();
      await expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
    }
  },
};

export const Grid: Story = {
  render: ({ locale }: Args) => (
    <ReaderActionsProvider signedIn={false} signInHref={signInHref}>
      <PageContainer>
        <WorkGrid works={[...classics, ...chinese]} locale={locale} />
      </PageContainer>
    </ReaderActionsProvider>
  ),
  async play({ canvasElement }) {
    // Untitled and unrated Works still line up: 水浒传 has no author and no rating.
    await expect(within(canvasElement).getByRole('link', { name: '水浒传' })).toBeVisible();
  },
};

function Rows({ locale, actions }: { locale: UiLocale; actions?: ReaderActions }) {
  return (
    <ReaderActionsProvider signedIn={false} signInHref={signInHref} actions={actions}>
      <PageContainer>
        <ol className="grid max-w-3xl divide-y divide-border/70">
          {[classics[0]!, chinese[0]!, guides[0]!, recipes[2]!].map((work) => (
            <li key={work.id} className="py-5">
              <WorkRow work={work} locale={locale}>
                <p>Matched in the English text</p>
              </WorkRow>
            </li>
          ))}
        </ol>
      </PageContainer>
    </ReaderActionsProvider>
  );
}

/** Search results: the shelf action at the row's end, "Want to read" in one press. */
export const ResultRows: Story = {
  args: { actions: memoryReaderActions({ [storyWorkId(21)]: { status: 'want-to-read' } }) },
  render: ({ locale, actions }: Args) => <Rows locale={locale} actions={actions} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const [pride] = canvas.getAllByRole('article');
    await userEvent.click(within(pride!).getByRole('button', { name: 'Want to read' }));
    await waitFor(() =>
      expect(within(pride!).getByRole('button', { name: /^Want to read — Shelve/ })).toBeVisible(),
    );
    await expect(
      canvas.getByRole('button', { name: /^Want to read — Shelve “西游记”/ }),
    ).toBeVisible();
  },
};

export const ResultRowsSignedOut: Story = {
  render: ({ locale }: Args) => <Rows locale={locale} />,
  async play({ canvasElement }) {
    const [first] = within(canvasElement).getAllByRole('link', { name: /Want to read/ });
    await expect(first).toHaveAttribute('href', signInHref);
  },
};

/** A write Main refuses is undone and said, never left looking saved. */
export const ShelfWriteRefused: Story = {
  render: () => (
    <ReaderActionsProvider
      signedIn
      signInHref={signInHref}
      actions={memoryReaderActions({}, { fail: true })}
    >
      <div className="w-64 p-6">
        <ShelfButton work={storyWorkId(1)} title="Pride and Prejudice" locale="en" />
      </div>
    </ReaderActionsProvider>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Want to read' }));
    await expect(await canvas.findByText('Couldn’t save. Try again.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Want to read' })).toBeVisible();
  },
};

export const RateInline: Story = {
  render: () => (
    <div className="flex flex-wrap gap-10 p-6">
      <ReaderActionsProvider signedIn signInHref={signInHref} actions={memoryReaderActions()}>
        <RateWork work={storyWorkId(1)} locale="en" />
      </ReaderActionsProvider>
      <ReaderActionsProvider signedIn={false} signInHref={signInHref}>
        <RateWork work={storyWorkId(1)} locale="en" />
      </ReaderActionsProvider>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /Rate this work/ })).toHaveAttribute(
      'href',
      signInHref,
    );
    await userEvent.click(canvas.getAllByRole('radio')[3]!);
    await waitFor(() => expect(canvas.getByText('Your rating')).toBeVisible());
  },
};

export const ChineseDark: Story = {
  args: { heading: { title: '经典小说' }, works: chinese, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) {
    // An unfinished serial is marked on its cover; finished works are not.
    await expect(within(canvasElement).getAllByText('连载中')).toHaveLength(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const overflow = canvasElement.ownerDocument.documentElement.scrollWidth > innerWidth;
    await expect(overflow).toBe(false);
  },
};
