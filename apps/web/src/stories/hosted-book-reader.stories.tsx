import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { HostedBookReader } from '../books/reader/hosted-book-reader';
import {
  createIllustrativeHostedBook,
  illustrativeBookIds,
  type IllustrativeBookState,
} from '../books/reader/illustrative-source';
import type { BookAddress } from '../books/reader/source';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

function BookJourney({ state = 'nested', chapter = false }: { state?: IllustrativeBookState; chapter?: boolean }) {
  const [runtime] = useState(() => {
    const book = createIllustrativeHostedBook(state);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    return { book, client };
  });
  const [address, setAddress] = useState<BookAddress | null>(() =>
    chapter ? null : runtime.book.contents(state === 'nested' ? null : illustrativeBookIds.nested),
  );
  useEffect(() => {
    let current = true;
    if (chapter)
      void runtime.book.chapter().then((value) => {
        if (current) setAddress(value);
      });
    return () => {
      current = false;
    };
  }, [runtime, chapter]);
  useEffect(() => () => runtime.client.clear(), [runtime]);
  return (
    <QueryClientProvider client={runtime.client}>
      <main className="min-w-0">
        <aside className="mx-auto grid max-w-5xl gap-3 px-4 pt-4 text-sm">
          <p role="note">
            Illustrative native-format Content responses through the actual native mapper and reader. These are authored
            examples, not API recordings or native admission evidence.
          </p>
          <button className="min-h-11 justify-self-start rounded border px-3" onClick={() => runtime.book.replace()}>
            Replace publication / target / viewer admission
          </button>
        </aside>
        {address ? (
          <HostedBookReader
            address={address}
            source={runtime.book.source}
            readingIdentity={runtime.book}
            locale={getLocale()}
          />
        ) : (
          <p role="status">Preparing illustrative responses…</p>
        )}
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Books/Hosted Book reader',
  id: 'interfaces-hosted-book-reader',
  component: BookJourney,
  parameters: { layout: 'fullscreen' },
  args: { state: 'nested', chapter: false },
} satisfies Meta<typeof BookJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function nestedJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText('Part I · The journey');
  await userEvent.click(canvas.getByRole('button', { name: `${m.book_reader_contents()} · Part I · The journey` }));
  await userEvent.click(await canvas.findByRole('button', { name: `${m.book_reader_contents()} · The observatory` }));
  const first = await canvas.findByRole('button', { name: `${m.book_reader_open_chapter()} · Dawn / 黎明` });
  await userEvent.click(first);
  await canvas.findByRole('heading', { level: 1, name: 'Dawn / 黎明' });
  await expect(canvas.getByRole('article')).toHaveTextContent('The keeper opened the eastern shutters.');
  await userEvent.click(canvas.getAllByRole('button', { name: m.book_reader_contents(), exact: true })[0]!);
  await expect(
    await canvas.findByRole('button', { name: `${m.book_reader_open_chapter()} · Dawn / 黎明` }),
  ).toHaveAttribute('aria-current', 'location');
}

async function failedPage({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.book_reader_more() }));
  await canvas.findByText(m.book_reader_unavailable());
  await userEvent.click(canvas.getByRole('button', { name: m.book_reader_retry() }));
  await canvas.findByText('Dawn, an echo / 再読');
  await expect(canvas.getByText(m.book_reader_level_end())).toBeVisible();
}

// The same named behavior states use the locale/theme globals and both screenshot widths (390 / 1280).
export const NestedContents: Story = { play: nestedJourney };
export const ExactChapter: Story = { args: { chapter: true } };
export const SparseContinuation: Story = { args: { state: 'sparse' } };
export const FailedPageRecovery: Story = { args: { state: 'failed-page' }, play: failedPage };
export const MovedOccurrence: Story = { args: { state: 'moved', chapter: true } };
export const UnavailableNavigation: Story = { args: { state: 'unavailable-navigation', chapter: true } };
export const RetiredReading: Story = {
  args: { chapter: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('article');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace publication / target / viewer admission' }));
    await canvas.findByText(m.book_reader_changed());
    await expect(canvas.queryByRole('article')).toBeNull();
  },
};
