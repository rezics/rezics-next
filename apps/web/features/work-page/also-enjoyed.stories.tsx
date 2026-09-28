import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import type { ScopeRealm } from './scope-bar.tsx';
import type { AlsoEnjoyedPage, Loaded } from './types.ts';

/** The rows as the Overview sets them, in a column as wide as the Work page's at 1440 pixels. */
function Rows({ alsoEnjoyed, book, realms, locale }: {
  alsoEnjoyed: Loaded<AlsoEnjoyedPage>; book: boolean; realms: ScopeRealm[]; locale: UiLocale;
}) {
  return <div className="mx-auto grid max-w-[46rem] gap-10 px-4 py-8 sm:px-8 [text-autospace:normal]">
    <AlsoEnjoyedSection alsoEnjoyed={alsoEnjoyed} book={book} realms={realms} locale={locale}
      messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Work page/Also enjoyed',
  component: Rows,
  args: { alsoEnjoyed: fixture.alsoEnjoyed(fixture.coReaderPicks), book: true, realms: fixture.realms.slice(0, 1),
    locale: 'en' },
} satisfies Meta<typeof Rows>;
export default meta;
type Story = StoryObj<typeof meta>;

const current = (row: HTMLElement) => within(row).getAllByRole('button', { name: /^Page / })
  .find(dot => dot.getAttribute('aria-current') === 'true')?.getAttribute('aria-label');
const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

/** Nine co-readers' picks: four to a page, paged by the arrows, the dots or the keyboard. */
export const CoReaders: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const row = canvas.getByRole('region', { name: 'Readers also enjoyed' });
    const cards = within(row).getAllByRole('article');
    await expect(cards).toHaveLength(9);
    // Goodreads' card: the cover, then the title (the one link), the author and "★ 4.26 · 100".
    await expect(within(row).getByRole('link', { name: 'John of John' }))
      .toHaveAttribute('href', `/en/w/${fixture.coReaderPicks[1]!.id.slice(-36)}`);
    await expect(cards[1]).toHaveTextContent('Douglas Stuart');
    await expect(cards[1]).toHaveTextContent('4.26');
    await expect(cards[1]).toHaveTextContent('· 100');
    await expect(cards[4]).toHaveTextContent('Ongoing');
    await waitFor(() => expect(current(row)).toBe('Page 1 of 3'));
    await expect(within(row).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(within(row).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(current(row)).toBe('Page 2 of 3'));
    await userEvent.click(within(row).getByRole('button', { name: 'Page 3 of 3' }));
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Next page' })).toBeDisabled());
    await expect(current(row)).toBe('Page 3 of 3');
    // A title reached by keyboard scrolls its page into view, and the dots follow.
    within(row).getByRole('link', { name: 'Seascraper' }).focus();
    await waitFor(() => expect(current(row)).toBe('Page 1 of 3'));
    await noOverflow();
  },
};

/** Each reason gets its own honestly titled row: co-readers, similar books, then the community's picks. */
export const MixedReasons: Story = {
  args: { alsoEnjoyed: fixture.alsoEnjoyed([...fixture.coReaderPicks.slice(0, 3), ...fixture.similarPicks,
    ...fixture.realmPicks]) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent))
      .toEqual(['Readers also enjoyed', 'Similar books', 'More from Tidewater Readers']);
    await expect(within(canvas.getByRole('region', { name: 'Similar books' })).getAllByRole('article')).toHaveLength(2);
    // A row that fits on one page needs no dots.
    await expect(canvas.queryByRole('button', { name: /^Page / })).toBeNull();
  },
};

/** A prompt's fallback: its kind is not a book, and several communities feature it, so none is named. */
export const CommunitiesAndSimilarWorks: Story = {
  args: { alsoEnjoyed: fixture.alsoEnjoyed([...fixture.similarPicks, ...fixture.realmPicks]), book: false,
    realms: fixture.realms },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent))
      .toEqual(['Similar works', 'More from the communities that feature it']);
  },
};

/** Nothing to recommend, or Main could not say: the row leaves no trace. */
export const Empty: Story = {
  args: { alsoEnjoyed: fixture.alsoEnjoyed([]) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('region')).toBeNull();
  },
};

export const Unavailable: Story = {
  args: { alsoEnjoyed: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('region')).toBeNull();
    await expect(within(canvasElement).queryByRole('alert')).toBeNull();
  },
};

/** Phones swipe, with the next cover peeking in; the dots mark the place. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const row = within(canvasElement).getByRole('region', { name: 'Readers also enjoyed' });
    await waitFor(() => expect(current(row)).toMatch(/^Page 1 of \d$/));
    // Touch screens swipe; the arrows are for a pointer.
    await expect(within(row).queryByRole('button', { name: 'Next page' })).toBeNull();
    await noOverflow();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const row = within(canvasElement).getByRole('region', { name: '读过的人也喜欢' });
    await waitFor(() => expect(within(row).getByRole('button', { name: '第 1 页，共 3 页' }))
      .toHaveAttribute('aria-current', 'true'));
    await expect(within(row).getByRole('heading', { name: '雨夜书店 · 连载小说' })).toHaveAttribute('lang', 'zh-Hans');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const PhoneDark: Story = { globals: { theme: 'dark', viewport: { value: 'phone' } }, play: noOverflow };
