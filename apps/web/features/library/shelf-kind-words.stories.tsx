import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { libraryItems, libraryState, memoryLibraryApi, storyNow, storyOverview, storyReaderActions, storyView } from './fixtures.ts';
import type { LibraryRow, ShelfStatus } from './types.ts';
import { LibraryPage } from './library-page.tsx';
import { messages } from './messages.ts';
import ja from './messages/ja.ts';

const meta = {
  title: 'Library/Kind words', component: LibraryPage,
  render: args => <LibraryPage {...args} api={memoryLibraryApi()} readerActions={storyReaderActions()} />,
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof LibraryPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const basis = libraryItems.find(row => row.status === 'want-to-read')!;
const statuses = ['want-to-read', 'reading', 'read'] as const satisfies readonly ShelfStatus[];
/** One Work of each kind on each status shelf: the stored status is the same three for every kind. */
const kinds = [
  ['Hollow Knight', 'https://schema.org/VideoGame'], ['Kimchi Stew', 'https://schema.org/Recipe'],
  ['Field Notes', 'https://schema.org/SoftwareApplication'], ['Middlemarch', 'https://schema.org/Book'],
] as const;
const rows: LibraryRow[] = kinds.flatMap(([title, type], kind) => statuses.map((status, index): LibraryRow => ({ ...basis, status,
  work: { ...basis.work, id: `https://rezics.com/id/0194f314-9280-767f-89a6-0000000001${kind}${index}`,
    title: { ...basis.work.title!, value: `${title} ${index + 1}` } },
  types: [type], startedOn: null, finishedOn: null, rating: null, customShelves: [] })));

const shelfArgs = (shelf: ShelfStatus, locale: 'en' | 'ja') => {
  const state = libraryState({ shelf });
  const items = rows.filter(row => row.status === shelf);
  return { state, overview: { ok: true as const, data: storyOverview(rows) }, view: { ok: true as const, data: storyView(state, items) },
    reading: [], now: storyNow, locale, messages: locale === 'ja' ? { ...messages, ...ja } : messages };
};
const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const said = (words: readonly string[], canvas: ReturnType<typeof within>) =>
  Promise.all(words.map(word => expect(canvas.getByText(word, { selector: 'p' })).toBeVisible()));

/** Games say want to play, recipes want to cook and software want to use; books keep their reading words, which the shelf already names. */
export const WantShelf: Story = {
  args: shelfArgs('want-to-read', 'en'),
  parameters: { route: { pathname: '/en/library', search: '?shelf=want-to-read' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await said(['Want to play', 'Want to cook', 'Want to use'], canvas);
    await expect(canvas.queryByText('Want to read', { selector: 'p' })).toBeNull();
    await noOverflow();
  },
};
export const WantShelfPhone: Story = { ...WantShelf, globals: { viewport: { value: 'phone' } } };

export const ReadingShelf: Story = {
  args: shelfArgs('reading', 'en'),
  parameters: { route: { pathname: '/en/library', search: '?shelf=reading' } },
  async play({ canvasElement }) {
    await said(['Playing', 'Cooking', 'Using'], within(canvasElement));
    await noOverflow();
  },
};

export const FinishedShelf: Story = {
  args: shelfArgs('read', 'en'),
  parameters: { route: { pathname: '/en/library', search: '?shelf=read' } },
  async play({ canvasElement }) {
    await said(['Played', 'Cooked', 'Used'], within(canvasElement));
    await noOverflow();
  },
};

export const WantShelfJapanesePhone: Story = {
  args: shelfArgs('want-to-read', 'ja'),
  parameters: { route: { pathname: '/ja/library', search: '?shelf=want-to-read' } },
  globals: { viewport: { value: 'phone' }, locale: 'ja' },
  async play({ canvasElement }) {
    await said(['遊びたい', '作りたい', '使いたい'], within(canvasElement));
    await noOverflow();
  },
};
