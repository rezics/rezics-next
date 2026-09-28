import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { bookClub, comfortReads, followedAuthors, libraryItems, libraryState, memoryLibraryApi, readingRows, storyNow,
  storyOverview, storyReaderActions, storyView } from './fixtures.ts';
import { LibraryPage } from './library-page.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

const zh = { ...messages, ...zhHans };
const all = libraryState();

const meta = {
  title: 'Library/Page', component: LibraryPage,
  args: { state: all, overview: { ok: true, data: storyOverview() }, view: { ok: true, data: storyView(all) },
    reading: readingRows, now: storyNow, locale: 'en', messages },
  // Fresh in-memory adapters for every story, so one story's writes never leak into the next.
  render: args => <LibraryPage {...args} api={args.api ?? memoryLibraryApi()}
    readerActions={args.readerActions ?? storyReaderActions()} />,
  parameters: { route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof LibraryPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const page = () => within(document.body);

/**
 * Picks an item from the open menu with the keyboard. Pointer presses in
 * menus opened by earlier stories' layers are not reliable in one test page.
 */
async function choose(role: 'menuitem' | 'menuitemradio', name: string | RegExp) {
  const item = await page().findByRole(role, { name });
  await waitFor(() => expect(item.closest('[data-part=content]')).toHaveFocus());
  for (let step = 0; step < 8 && !item.hasAttribute('data-highlighted'); step++) await userEvent.keyboard('{ArrowDown}');
  await expect(item).toHaveAttribute('data-highlighted');
  await userEvent.keyboard('{Enter}');
}

/** Every shelf with its count beside the list, Currently reading first, and each Work with what its shelf calls for. */
export const All: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
    await expect(canvas.getByText('12 works', { selector: 'p' })).toBeVisible();
    const shelves = within(canvas.getByRole('navigation', { name: 'Shelves' }));
    await expect(shelves.getByRole('link', { name: 'All 12' })).toHaveAttribute('aria-current', 'page');
    await expect(shelves.getByRole('link', { name: 'Read 4' })).toHaveAttribute('href', '/en/library?shelf=read');
    await expect(shelves.getByRole('link', { name: 'Comfort reads Only you can see this shelf' }))
      .toHaveAttribute('href', `/en/library?shelf=${comfortReads.id.slice(-36)}`);
    // Continue opens the next unread chapter.
    const reading = within(canvas.getByRole('region', { name: 'Currently reading' }));
    await expect(reading.getAllByRole('heading', { level: 3 })).toHaveLength(3);
    await expect(reading.getAllByRole('link', { name: /^Continue/ })[0]).toHaveAttribute('href',
      `/en/w/${libraryItems[0]!.work.id.slice(-36)}/read/chapter-10`);
    await expect(reading.getByRole('progressbar', { name: /雨夜书店/ })).toHaveAttribute('aria-valuenow', '75');
    const list = within(canvas.getByRole('region', { name: 'All 12' }));
    await expect(list.getByRole('button', { name: 'Sort: Date added' })).toBeVisible();
    await expect(list.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    await expect(list.getByText('Read Jan 2 – 12, 2026')).toBeVisible();
    await expect(list.getByText('Funnier than I remembered.', { exact: false })).toBeVisible();
  },
};

/** Read history as Goodreads keeps it: dates, stars and the review, each changed in place. */
export const ReadHistory: Story = {
  args: { state: libraryState({ shelf: 'read' }), view: { ok: true, data: storyView(libraryState({ shelf: 'read' })) },
    reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Read 4' })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Currently reading' })).toBeNull();
    // Dates: the finish date is edited in a popover and checked against the start.
    await userEvent.click(canvas.getByRole('button', { name: 'Add dates — Frankenstein; or, The Modern Prometheus' }));
    const dates = await page().findByRole('dialog', { name: /Reading dates for “Frankenstein/ }, { timeout: 5000 });
    await userEvent.type(within(dates).getByLabelText('Started'), '2026-05-10');
    await userEvent.type(within(dates).getByLabelText('Finished'), '2026-05-01');
    await userEvent.click(within(dates).getByRole('button', { name: 'Save' }));
    // The error fades in; wait until it has.
    await waitFor(() => expect(within(dates).getByText('The finish date can’t be before the start date.')).toBeVisible(),
      { timeout: 3000 });
    await userEvent.clear(within(dates).getByLabelText('Finished'));
    await userEvent.type(within(dates).getByLabelText('Finished'), '2026-05-20');
    await userEvent.click(within(dates).getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByText('Read May 10 – 20, 2026', {}, { timeout: 3000 })).toBeVisible();
    // The editor closes before the page takes presses again.
    await waitFor(() => expect(page().queryByRole('dialog')).toBeNull(), { timeout: 3000 });
    // A review needs stars first; rating unlocks it.
    await userEvent.click(canvas.getByRole('button', { name: 'Write a review — Frankenstein; or, The Modern Prometheus' }));
    const editor = await canvas.findByRole('textbox', { name: /Your review of “Frankenstein/ }, { timeout: 5000 });
    await userEvent.type(editor, 'The monster’s account is the best part.');
    await expect(canvas.getByText('Rate this work first; your review goes with your rating.')).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Save review' }, { timeout: 5000 })).toBeDisabled();
  },
};

/** Imported private review text stays in Library and is labelled with its disclosure. */
export const PrivateImportedReview: Story = {
  args: (() => {
    const state = libraryState({ shelf: 'read' });
    const view = storyView(state);
    return { state, reading: [], view: { ok: true as const, data: { ...view,
      rows: view.rows.map((row, index) => index === 0 ? { ...row, privateReview: { ok: true as const,
        data: { work: row.work.id, text: 'A note I kept for myself.', language: 'en', spoiler: false,
          version: 1, changedAt: '2026-06-01T00:00:00Z' } } } : row) } } };
  })(),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Private review', { exact: false })).toBeVisible();
    await expect(canvas.getByText('A note I kept for myself.')).toBeVisible();
  },
};

/** A Work already rated: the review is written and saved in place, spoiler marked. */
export const WriteReview: Story = {
  args: { state: libraryState({ shelf: 'read' }), view: { ok: true, data: storyView(libraryState({ shelf: 'read' })) },
    reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Write a review — 西游记' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Your review of “西游记”' }), '取经路上最动人的是师徒之间的吵吵闹闹。');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Contains spoilers' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save review' }));
    // Saved, the editor closes and the review shows with its spoiler mark beside the other one.
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: 'Your review of “西游记”' })).toBeNull(),
      { timeout: 3000 });
    await expect(canvas.getByText('取经路上最动人的是师徒之间的吵吵闹闹。')).toBeVisible();
    await expect(canvas.getAllByText('Spoiler')).toHaveLength(2);
  },
};

/** Stars change in place; Main refusing takes them back with a note. */
export const RatingFails: Story = {
  args: { state: libraryState({ shelf: 'read' }), view: { ok: true, data: storyView(libraryState({ shelf: 'read' })) },
    reading: [], api: memoryLibraryApi({ fail: true }) },
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const stars = canvas.getByRole('radiogroup', { name: 'Your rating — Frankenstein; or, The Modern Prometheus' });
    await userEvent.click(within(stars).getAllByRole('radio')[3]!);
    await expect(await canvas.findByText('Couldn’t save your rating. Try again.', {}, { timeout: 3000 })).toBeVisible();
  },
};

/** Select turns on boxes; the bar moves the chosen Works together and says what happened. */
export const MoveSeveral: Story = {
  args: { state: libraryState({ shelf: 'want-to-read' }),
    view: { ok: true, data: storyView(libraryState({ shelf: 'want-to-read' })) }, reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=want-to-read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Select' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “Little Women”' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “聊斋志异”' }));
    const bar = await page().findByRole('toolbar', { name: 'Selected works' });
    // The bar fades in.
    await waitFor(() => expect(within(bar).getByText('2 selected')).toBeVisible());
    await userEvent.click(within(bar).getByRole('button', { name: 'Move to' }));
    // The shelf the Works are on is not offered.
    await expect(page().queryByRole('menuitem', { name: 'Want to read' })).toBeNull();
    await choose('menuitem', 'Currently reading');
    await expect(await canvas.findByText('Moved 2 works to Currently reading.', {}, { timeout: 3000 })).toBeVisible();
    await waitFor(() => expect(page().queryByRole('toolbar', { name: 'Selected works' })).toBeNull());
  },
};

/** A row's own shelf button moves one Work, and the page says where it went before the row leaves. */
export const MoveOne: Story = {
  args: { state: libraryState({ shelf: 'read' }), view: { ok: true, data: storyView(libraryState({ shelf: 'read' })) },
    reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Read — Shelve “西游记”' }));
    await choose('menuitemradio', 'Currently reading');
    await expect(await canvas.findByText('“西游记” is now on Currently reading.', {}, { timeout: 3000 })).toBeVisible();
  },
};

/** Selected Works join one of the reader's own shelves. */
export const AddToShelf: Story = {
  args: { state: libraryState({ shelf: 'read' }), view: { ok: true, data: storyView(libraryState({ shelf: 'read' })) },
    reading: [] },
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Select' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select all on this page' }));
    const bar = await page().findByRole('toolbar', { name: 'Selected works' });
    await waitFor(() => expect(within(bar).getByText('4 selected')).toBeVisible());
    await userEvent.click(within(bar).getByRole('button', { name: 'Add to shelf' }));
    await choose('menuitem', /Comfort reads/);
    await expect(await canvas.findByText('Added 4 works to Comfort reads.', {}, { timeout: 3000 })).toBeVisible();
  },
};

/** Covers instead of rows: the reader's stars under read Works and chapters read under those in progress. */
export const Grid: Story = {
  args: { state: libraryState({ view: 'grid' }), view: { ok: true, data: storyView(libraryState({ view: 'grid' })) } },
  parameters: { route: { pathname: '/en/library', search: '?view=grid' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Grid' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getAllByText('9 of 12 chapters')).toHaveLength(2);
    await expect(canvas.queryByRole('button', { name: /Write a review/ })).toBeNull();
  },
};

/** A shelf the reader made: its own order, a lock when private, and removal from it rather than from the library. */
export const CustomShelf: Story = {
  args: { state: libraryState({ shelf: comfortReads.id.slice(-36) }),
    view: { ok: true, data: storyView(libraryState({ shelf: comfortReads.id.slice(-36) })) }, reading: [] },
  parameters: { route: { pathname: '/en/library', search: `?shelf=${comfortReads.id.slice(-36)}` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: /^Comfort reads 2/ })).toBeVisible();
    await expect(canvas.getByText('In shelf order')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Select' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “三国演义”' }));
    const bar = await page().findByRole('toolbar', { name: 'Selected works' });
    await expect(within(bar).queryByRole('button', { name: 'Remove from library' })).toBeNull();
    await userEvent.click(within(bar).getByRole('button', { name: 'Remove from this shelf' }));
    await expect(await canvas.findByText('Removed 1 work.', {}, { timeout: 3000 })).toBeVisible();
  },
};

/** An empty custom shelf says how to fill it. */
export const EmptyCustomShelf: Story = {
  args: { state: libraryState({ shelf: bookClub.id.slice(-36) }),
    view: { ok: true, data: { ...storyView(libraryState({ shelf: bookClub.id.slice(-36) }), []) } }, reading: [] },
};

/** Who can see the status shelves is changed where they are. */
export const Privacy: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Who can see your reading shelves: Everyone' }));
    await choose('menuitemradio', /^Only you/);
    await expect(await canvas.findByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
    await expect(canvas.getByText(/^Only you can see them\./)).toBeVisible();
  },
};

/** Another device changed the setting first: Library shows what Main holds now and says so. */
export const PrivacyChangedElsewhere: Story = {
  args: { overview: { ok: true, data: storyOverview(libraryItems, { visibility: { ok: true,
    data: { visibility: 'private', version: 1, changedAt: null } } }) }, api: memoryLibraryApi({ stale: true }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' }));
    // Followers is not offered while Main keeps it reserved.
    await expect(page().queryByRole('menuitemradio', { name: /^Followers/ })).toBeNull();
    await choose('menuitemradio', /^Everyone/);
    await expect(await canvas.findByText('Changed on another device; this is the current setting.', {},
      { timeout: 3000 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
  },
};

/** Nothing shelved yet: what the shelves are for, and where to find something. */
export const FirstUse: Story = {
  args: { overview: { ok: true, data: storyOverview([], { customShelves: [] }) },
    view: { ok: true, data: storyView(all, []) }, reading: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Your library starts here' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Discover works' })).toHaveAttribute('href', '/en/discover');
    await expect(canvas.getByRole('link', { name: 'Go to your feed' })).toHaveAttribute('href', '/en');
    await expect(canvas.queryByRole('navigation', { name: 'Shelves' })).toBeNull();
  },
};

/** An empty status shelf, with the rest of the library still there. */
export const EmptyShelf: Story = {
  args: { state: libraryState({ shelf: 'reading' }), reading: [],
    overview: { ok: true, data: storyOverview(libraryItems.filter(row => row.status !== 'reading')) },
    view: { ok: true, data: storyView(libraryState({ shelf: 'reading' }), []) } },
  parameters: { route: { pathname: '/en/library', search: '?shelf=reading' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'You’re not reading anything right now' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Select' })).toBeNull();
  },
};

/** Main refuses this identity a library: an organization's Agent, say. */
export const Denied: Story = {
  args: { overview: { ok: false, failure: 'sign-in' }, view: { ok: false, failure: 'sign-in' }, reading: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'This identity has no library' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Choose identity' }))
      .toHaveAttribute('href', `/en/identity?next=${encodeURIComponent('/en/library')}`);
  },
};

/** The shelf could not load; the shelves and the header stay. */
export const ShelfUnavailable: Story = {
  args: { view: { ok: false, failure: 'unavailable' }, reading: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Couldn’t load this shelf');
    await expect(canvas.getByRole('navigation', { name: 'Shelves' })).toBeVisible();
  },
};

/** The shelf changed between Main's pages. */
export const ShelfMoved: Story = { args: { view: { ok: false, failure: 'moved' }, reading: [] } };

/** A custom shelf the reader does not have. */
export const MissingShelf: Story = { args: { view: { ok: false, failure: 'missing' }, reading: [] } };

export const Phone: Story = { globals: { viewport: { value: 'phone' } } };

export const PhoneReadHistory: Story = { ...ReadHistory, play: undefined, globals: { viewport: { value: 'phone' } } };

export const Dark: Story = { globals: { theme: 'dark' } };

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: zh },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/library' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '书架' })).toBeVisible();
    await expect(within(canvas.getByRole('navigation', { name: '书架' })).getByRole('link', { name: '读过 4' }))
      .toHaveAttribute('href', '/zh-Hans/library?shelf=read');
  },
};

export const ChinesePhoneDark: Story = { ...Chinese, play: undefined,
  globals: { locale: 'zh-Hans', theme: 'dark', viewport: { value: 'phone' } } };

/**
 * The authors the reader follows, REZICS and Open Library authors alike, each
 * with their newest Work, newest first. One who is no longer public is left out.
 */
export const AuthorsYouFollow: Story = {
  args: { authors: { ok: true, data: followedAuthors } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Authors you follow' });
    const authors = within(region);
    const tiles = authors.getAllByRole('listitem');
    await expect(tiles).toHaveLength(3);
    // Lin Mei's serial is newer on REZICS than Pride and Prejudice; an author with nothing public comes last.
    await expect(within(tiles[0]!).getByRole('link', { name: 'Lin Mei 林梅' })).toHaveAttribute('href', '/en/@lin_mei');
    await expect(within(tiles[0]!).getByRole('link', { name: /^雨夜书店/ })).toBeVisible();
    await expect(within(tiles[1]!).getByRole('link', { name: 'Jane Austen' }))
      .toHaveAttribute('href', '/en/authors/open-library/OL21594A');
    await expect(within(tiles[1]!).getByText('Newest work')).toBeVisible();
    await expect(within(tiles[1]!).getByRole('link', { name: 'Pride and Prejudice' })).toBeVisible();
    await expect(within(tiles[2]!).getByText('No works on REZICS yet')).toBeVisible();
    // Between Currently reading and the shelf.
    const reading = canvas.getByRole('region', { name: 'Currently reading' });
    await expect(reading.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  },
};

export const AuthorsYouFollowPhone: Story = {
  args: { authors: { ok: true, data: followedAuthors } },
  globals: { viewport: { value: 'phone' } },
};

export const AuthorsYouFollowChinese: Story = {
  args: { authors: { ok: true, data: followedAuthors }, locale: 'zh-Hans', messages: zh },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/zh-Hans/library' } },
  async play({ canvasElement }) {
    const authors = within(within(canvasElement).getByRole('region', { name: '关注的作者' }));
    await expect(authors.getAllByText('最新作品')).toHaveLength(2);
    await expect(authors.getByText('REZICS 上还没有作品')).toBeVisible();
  },
};

/** The authors could not be read: the rest of Library stays, with a way to try again. */
export const AuthorsUnavailable: Story = {
  args: { authors: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Couldn’t load the authors you follow' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'All 12' })).toBeVisible();
  },
};

/** A reader who has shelved nothing yet still sees the authors they follow under the first steps. */
export const AuthorsOnFirstUse: Story = {
  args: { overview: { ok: true, data: storyOverview([], { customShelves: [] }) }, view: { ok: true, data: storyView(all, []) },
    reading: [], authors: { ok: true, data: followedAuthors } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Authors you follow' })).toBeVisible();
  },
};
