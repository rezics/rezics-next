import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { LibraryImport } from './library-import.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { ImportedBook } from './import-csv.ts';

const csv = `Book Id,Title,Author,ISBN13,My Rating,Date Read,Bookshelves,Exclusive Shelf,My Review
1,Pride and Prejudice,Jane Austen,9780141439518,5,2026/01/03,"classics, favorites",read,"A favorite."
2,Jane Eyre,Charlotte Brontë,,4,2026/02/14,classics,read,
3,Frankenstein,Mary Shelley,,4,2026/03/05,classics,read,
4,Little Women,Louisa May Alcott,,5,2026/04/01,classics,read,
5,The Odyssey,Homer,,3,,classics,to-read,
6,Moby-Dick,Herman Melville,,4,,classics,currently-reading,
7,雨夜书店,林雨,,5,2026/05/19,fiction,read,雨夜的故事。
8,Ambiguous Tale,Alex Lee,,,2026/06/02,fiction,read,
9,Unknown Book,Nobody,,,,to-read,
10,Great Expectations,Charles Dickens,,4,2026/07/20,classics,read,`;

const id = (index: number) => `https://rezics.com/id/0194f314-9280-767f-89a6-${index.toString().padStart(12, '0')}`;
const lookup = async (book: ImportedBook) => book.title === 'Unknown Book' ? []
  : book.title === 'Ambiguous Tale'
    ? [8, 9].map(index => ({ work: id(index), title: book.title, authors: [book.author], isbn13: [] }))
    : [{ work: id(book.row), title: book.title, authors: [book.author],
      isbn13: book.isbn ? [book.isbn] : [] }];

const meta = { title: 'Library/Import', component: LibraryImport,
  args: { agent: id(99), context: id(100), locale: 'en', messages, lookup,
    ensureShelf: async () => id(1000),
    importRow: async (_agent, _book, selection) => ({ work: selection.work, applied: ['status'], issues: [] }) },
  parameters: { route: { pathname: '/en/library' } },
} satisfies Meta<typeof LibraryImport>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TenBookReview: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  const file = new File([csv], 'goodreads_library_export.csv', { type: 'text/csv' });
  await userEvent.upload(canvas.getByLabelText('Library CSV file'), file);
  await waitFor(() => expect(canvas.queryByText(/Checking matches:/)).toBeNull(), { timeout: 5000 });
  await expect(canvas.getByText('Pride and Prejudice')).toBeVisible();
  await expect(canvas.getByText('雨夜书店')).toBeVisible();
  await expect(canvas.getByText('No match found')).toBeVisible();
  await expect(canvas.getByText('Choose a Work')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Import selected books' }));
  await expect(await canvas.findByText(/Imported 8 books/)).toBeVisible();
} };

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '导入书架' })).toBeVisible();
    await userEvent.click(canvas.getByText('导入书架'));
    await expect(canvas.getByText('选择 Goodreads 或 StoryGraph 导出的 CSV 文件。保存前请核对每本书的匹配结果。'))
      .toBeVisible();
  } };
