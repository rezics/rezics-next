import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { memoryFollowActions } from '../profile/fixtures.ts';
import { AuthorPage, AuthorUnavailable, AuthorWorksListPage } from './author-page.tsx';
import {
  austenWorksPage,
  authorFollow,
  caoXueqin,
  conanDoyle,
  janeAusten,
  lewisCarroll,
  prolificAuthor,
  storyId,
  unnamedAuthor,
} from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const zh = { ...messages, ...zhHans };
/** A Work row's credit line as read aloud: its names are links, so the line is matched whole. */
const creditLine = (text: string) => (_: string, element: Element | null) =>
  element?.matches('p.text-muted-foreground') === true && element.textContent === text;
const signedOut = { signedIn: false };
const signedIn = { signedIn: true, actingSubject: storyId(77), seed: {} };

const meta = {
  title: 'Author/Page',
  component: AuthorPage,
  args: {
    author: janeAusten,
    follow: authorFollow(janeAusten, 1),
    reader: signedOut,
    locale: 'en',
    messages,
  },
  parameters: { route: { pathname: '/en/authors/open-library/OL21594A' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof AuthorPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Jane Austen as Goodreads frames an author: name and years, what her Works
 * add up to, her Works most rated first, and the record behind the page.
 */
export const OpenLibraryAuthor: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Jane Austen' })).toBeVisible();
    await expect(canvas.getByText('1775–1817')).toBeVisible();
    const totals = within(canvas.getByLabelText('On REZICS'));
    await expect(totals.getByText('works')).toBeVisible();
    await expect(totals.getByText('3.75')).toBeVisible();
    await expect(totals.getByText('ratings')).toBeVisible();
    await expect(totals.getByText('reader')).toBeVisible();
    const works = within(canvas.getByRole('region', { name: 'Works by Jane Austen' }));
    await expect(works.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    await expect(works.getByRole('link', { name: 'Pride and Prejudice' })).toHaveAttribute(
      'href',
      localizedPath(resourceHref('/w/', storyId(101).slice(-36)), 'en'),
    );
    // A co-written Work names both authors in credit order.
    await expect(works.getByText(creditLine('Jane Austen, Margaret Drabble'))).toBeVisible();
    // Signed out, the shelf button leads to sign-in and back to this page.
    await expect(works.getAllByRole('link', { name: /Want to read/ })[0]).toHaveAttribute(
      'href',
      `/auth/start?next=${encodeURIComponent('/en/authors/open-library/OL21594A')}`,
    );
    const details = within(canvas.getByRole('region', { name: 'Details' }));
    await expect(details.getByText('December 16, 1775')).toBeVisible();
    await expect(details.getByText('July 18, 1817')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Project Gutenberg/ })).toHaveAttribute(
      'href',
      'https://www.gutenberg.org/ebooks/author/68',
    );
    const records = within(canvas.getByRole('region', { name: 'Catalogues and identifiers' }));
    await expect(records.getAllByRole('link')).toHaveLength(5);
    await expect(records.getByRole('link', { name: /Open Library/ })).toHaveAttribute(
      'href',
      'https://openlibrary.org/authors/OL21594A',
    );
    await expect(canvas.getByText(/retrieved September 28, 2026/)).toBeVisible();
    // Signed out, Follow leads to sign-in and back here; the count is everyone's, never who.
    await expect(canvas.getByText('1 follower')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /^Follow/ })).toHaveAttribute(
      'href',
      `/auth/start?next=${encodeURIComponent('/en/authors/open-library/OL21594A')}`,
    );
  },
};

/** Following shows at once, as on a REZICS author's profile, and the count moves with it. */
export const Follow: Story = {
  args: {
    reader: signedIn,
    follow: authorFollow(janeAusten, 1, false),
    followActions: memoryFollowActions(),
    readerActions: memoryReaderActions(),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Jane Austen' }));
    await expect(
      canvas.getByRole('button', { name: 'Following · Unfollow Jane Austen' }),
    ).toBeVisible();
    await expect(canvas.getByText('2 followers')).toBeVisible();
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /^Following/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await userEvent.click(canvas.getByRole('button', { name: /^Following/ }));
    await expect(canvas.getByRole('button', { name: 'Follow · Jane Austen' })).toBeVisible();
    await expect(canvas.getByText('1 follower')).toBeVisible();
  },
};

/** Main refused the follow: the press is taken back and a note says to try again. */
export const FollowFails: Story = {
  args: {
    reader: signedIn,
    follow: authorFollow(janeAusten, 1, false),
    followActions: memoryFollowActions({ fail: true }),
    readerActions: memoryReaderActions(),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Follow · Jane Austen' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Couldn’t update. Try again.',
    );
    await expect(canvas.getByRole('button', { name: 'Follow · Jane Austen' })).toBeVisible();
    await expect(canvas.getByText('1 follower')).toBeVisible();
  },
};

/** The count could not be read: the button stays and no number is guessed. */
export const FollowCountUnavailable: Story = {
  args: { follow: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /^Follow/ })).toBeVisible();
    await expect(canvas.queryByText(/follower/)).toBeNull();
  },
};

export const Phone: Story = { globals: { viewport: { value: 'phone' } } };

export const Dark: Story = { globals: { theme: 'dark' } };

export const DarkPhone: Story = { globals: { theme: 'dark', viewport: { value: 'phone' } } };

/** Nobody has rated or finished these Works yet; the totals say so rather than hide. */
export const NotYetRated: Story = {
  args: { author: conanDoyle },
  parameters: { route: { pathname: '/en/authors/open-library/OL161167A' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Arthur Conan Doyle' }),
    ).toBeVisible();
    await expect(canvas.getByText('May 22, 1859')).toBeVisible();
    await expect(canvas.queryByText('average rating')).toBeNull();
    await expect(canvas.getByText('ratings')).toBeVisible();
    await expect(canvas.getByText('readers')).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Read and listen free' })).not.toBeNull();
  },
};

/** An approximate year, a Chinese name and a Work written with another author, in Chinese. */
export const Chinese: Story = {
  args: { author: caoXueqin, locale: 'zh-Hans', messages: zh },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/authors/open-library/OL15030763A' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '曹雪芹' })).toBeVisible();
    await expect(canvas.getByText('约1717年—1763年')).toBeVisible();
    await expect(canvas.getByRole('region', { name: '曹雪芹的作品' })).toBeVisible();
    await expect(canvas.getByText(creditLine('曹雪芹、高鹗'))).toBeVisible();
    await expect(canvas.getByText('部作品')).toBeVisible();
    await expect(canvas.queryByRole('region', { name: '免费阅读与收听' })).toBeNull();
    await expect(canvas.getByRole('link', { name: /Open Library/ })).toBeVisible();
  },
};

export const EnglishAuthorInChinese: Story = {
  args: {
    locale: 'zh-Hans',
    messages: zh,
    reader: signedIn,
    follow: authorFollow(janeAusten, 1_000, true, 'lower-bound'),
    followActions: memoryFollowActions(),
  },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/zh-Hans/authors/open-library/OL21594A' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: '已关注 · 取消关注Jane Austen' }),
    ).toBeVisible();
    await expect(canvas.getByText('1,000+ 位关注者')).toBeVisible();
    await expect(canvas.getByText('1775年—1817年')).toBeVisible();
    await expect(canvas.getByText('1775年12月16日')).toBeVisible();
    await expect(canvas.getByText(/获取于2026年9月28日/)).toBeVisible();
  },
};

/** A fuller name, and a date the source wrote in its own words, which the page keeps as written. */
export const FullerName: Story = {
  args: { author: lewisCarroll },
  parameters: { route: { pathname: '/en/authors/open-library/OL22098A' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Charles Lutwidge Dodgson')).toBeVisible();
    await expect(canvas.getByText('winter of 1898')).toBeVisible();
    await expect(canvas.getByText('Born 1832')).toBeVisible();
    await expect(canvas.queryByText('readers')).toBeNull();
  },
};

/** Before REZICS names an author, the page uses their Open Library ID and claims no facts. */
export const Unnamed: Story = {
  args: { author: unnamedAuthor },
  parameters: { route: { pathname: '/en/authors/open-library/OL15669783A' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Open Library author OL15669783A' }),
    ).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Details' })).toBeNull();
    await expect(canvas.getByText('Name and facts from Open Library’s catalogue.')).toBeVisible();
  },
};

/** More Works than the overview lists, and counts past what Main counts exactly. */
export const Prolific: Story = {
  args: { author: prolificAuthor },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('64+')).toBeVisible();
    await expect(canvas.getByText('41.9K+')).toBeVisible();
    await expect(canvas.getByText('10K+')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'All works' })).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A/works',
    );
  },
};

/** Signed in: shelving a Work from the author page files it at once. */
export const SignedIn: Story = {
  args: {
    reader: { signedIn: true, actingSubject: storyId(77), seed: {} },
    readerActions: memoryReaderActions(),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const works = within(canvas.getByRole('region', { name: 'Works by Jane Austen' }));
    await userEvent.click(works.getAllByRole('button', { name: 'Want to read' })[0]!);
    await expect(await works.findByRole('button', { name: /^Want to read — / })).toBeVisible();
  },
};

/** Main could not answer: the page says so and offers a retry. */
export const Unavailable: Story = {
  render: () => <AuthorUnavailable authorKey="/authors/OL21594A" locale="en" messages={messages} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Couldn’t load this author' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Retry' })).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A',
    );
  },
};

/** `/works`: every Work, twenty to a page, back to the author at the top. */
export const AllWorks: Story = {
  render: () => (
    <AuthorWorksListPage
      author={prolificAuthor}
      works={{ ok: true, data: austenWorksPage }}
      reader={signedOut}
      locale="en"
      messages={messages}
    />
  ),
  parameters: { route: { pathname: '/en/authors/open-library/OL21594A/works' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 1, name: 'Works by Jane Austen' }),
    ).toBeVisible();
    await expect(canvas.getAllByRole('heading', { level: 2 })).toHaveLength(10);
    await expect(canvas.getByRole('link', { name: /Back to Jane Austen/ })).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A',
    );
    await expect(canvas.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A/works?cursor=story-next',
    );
  },
};

/** A later page after the list changed: restart from the first page. */
export const AllWorksMoved: Story = {
  render: () => (
    <AuthorWorksListPage
      author={prolificAuthor}
      works={{ ok: false, failure: 'moved' }}
      cursor="story-next"
      reader={signedOut}
      locale="en"
      messages={messages}
    />
  ),
  parameters: { route: { pathname: '/en/authors/open-library/OL21594A/works' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { level: 2, name: 'This list changed while you were paging' }),
    ).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'First page' })[0]).toHaveAttribute(
      'href',
      '/en/authors/open-library/OL21594A/works',
    );
  },
};
