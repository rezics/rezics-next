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

const args = (locale: 'en' | 'ja') => {
  const state = libraryState();
  return { state, overview: { ok: true as const, data: storyOverview(rows) }, view: { ok: true as const, data: storyView(state, rows) },
    reading: [], now: storyNow, locale, messages: locale === 'ja' ? { ...messages, ...ja } : messages };
};
const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Games say play, recipes cook and software use on every row; books keep reading words, which the shelf names already say. */
export const PerKind: Story = {
  args: args('en'),
  parameters: { route: { pathname: '/en/library' } },
  async play({ canvasElement }) {
    const list = within(canvasElement);
    await expect(list.getByText('Want to play')).toBeVisible();
    await expect(list.getByText('Playing')).toBeVisible();
    await expect(list.getByText('Played')).toBeVisible();
    await expect(list.getByText('Want to cook')).toBeVisible();
    await expect(list.getByText('Cooking')).toBeVisible();
    await expect(list.getByText('Cooked')).toBeVisible();
    await expect(list.getByText('Want to use')).toBeVisible();
    await expect(list.getByText('Using')).toBeVisible();
    await expect(list.getByText('Used', { exact: true })).toBeVisible();
    await noOverflow();
  },
};
export const PerKindPhone: Story = { ...PerKind, globals: { viewport: { value: 'phone' } } };

export const PerKindJapanese: Story = {
  args: args('ja'),
  parameters: { route: { pathname: '/ja/library' } },
  globals: { viewport: { value: 'phone' }, locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('遊びたい')).toBeVisible();
    await expect(canvas.getByText('プレイ中')).toBeVisible();
    await expect(canvas.getByText('調理中')).toBeVisible();
    await expect(canvas.getByText('使用中')).toBeVisible();
    await noOverflow();
  },
};
