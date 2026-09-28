import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { LibraryImport } from './library-import.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { ImportedBook } from './import-csv.ts';
import { submitReviewedBatch, type ImportBatchProgress } from './import-api.ts';

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
    importBatch: async (_agent, _context, _locale, _shelves, rows, onProgress) => {
      const result: ImportBatchProgress = { items: rows.map((row, index) => ({ index,
        result: { work: row.work, applied: ['status'], issues: [] } })), total: rows.length, pending: false };
      onProgress?.(result);
      return result;
    } },
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
  await expect(canvas.getAllByText('Pride and Prejudice').some(node => node.classList.contains('font-medium')))
    .toBe(true);
  await expect(canvas.getAllByText('雨夜书店').some(node => node.classList.contains('font-medium'))).toBe(true);
  await expect(canvas.getByText('8 found')).toBeVisible();
  await expect(canvas.getByText('2 need a match')).toBeVisible();
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

export const ChineseDarkReview: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('导入书架'));
    await userEvent.upload(canvas.getByLabelText('书架 CSV 文件'),
      new File([csv], 'goodreads.csv', { type: 'text/csv' }));
    await waitFor(() => expect(canvas.queryByText(/正在匹配：/)).toBeNull());
    await expect(canvas.getByText('已找到 8 本')).toBeVisible();
    await expect(canvas.getByText('2 本待匹配')).toBeVisible();
  },
};

/** The first press preserves a newer personal edit and creates no stray imported shelf. */
export const ConflictChoice: Story = { args: (() => {
  const importBatch: typeof submitReviewedBatch = async (_agent, _context, _locale, _shelves,
    rows, onProgress) => {
    const result: ImportBatchProgress = { items: [{ index: 0, result: { work: rows[0]!.work, applied: [],
      issues: rows[0]!.conflictChoice ? [] : ['status-changed'] } }], total: 1, pending: false };
    onProgress?.(result);
    return result;
  };
  return { lookup: async (book: ImportedBook) => [{ work: id(1), title: book.title,
    authors: [book.author], isbn13: [] }], importBatch };
})(), async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  const file = new File(['Book Id,Title,Author,Exclusive Shelf,Bookshelves\n1,Pride and Prejudice,Jane Austen,read,classics\n'],
    'goodreads.csv', { type: 'text/csv' });
  await userEvent.upload(canvas.getByLabelText('Library CSV file'), file);
  await waitFor(() => expect(canvas.queryByText(/Checking matches:/)).toBeNull());
  await userEvent.click(canvas.getByRole('button', { name: 'Import selected books' }));
  await expect(await canvas.findByRole('button', { name: 'Keep mine' })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Keep mine' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Import selected books' }));
  await expect(await canvas.findByText('Imported 1 book.')).toBeVisible();
} };
