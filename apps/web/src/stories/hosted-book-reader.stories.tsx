import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { HostedBookReader, type HostedBookReaderProps } from '../books/reader/hosted-book-reader';
import { HostedBookCheckpointControls } from '../books/reader/checkpoint-controls';
import { createHostedBookNavigation } from '../books/reader/route';
import { hostedBookAddressHref } from '../books/reader/address';
import {
  createIllustrativeHostedBook,
  illustrativeBookIds,
  type IllustrativeBookState,
} from '../books/reader/illustrative-source';
import type { BookAddress, BookChapterAddress, BookChapterPage, BookContentsAddress, BookPage } from '../books/reader/source';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

type SavedReading = { address: BookChapterAddress; title: string };
type CheckpointState = 'none' | 'saved' | 'unavailable';
type JourneyProps = {
  state?: IllustrativeBookState;
  chapter?: boolean;
  direct?: 'first' | 'night';
  checkpoint?: CheckpointState;
  startAtRoot?: boolean;
};

function IllustrativeCheckpoint({
  page,
  current,
  initialState,
  saved,
  setSaved,
  open,
}: {
  page: BookPage;
  current: () => boolean;
  initialState: CheckpointState;
  saved: SavedReading | null;
  setSaved: (value: SavedReading | null) => void;
  open: (address: BookChapterAddress) => void;
}) {
  const [unavailable, setUnavailable] = useState(initialState === 'unavailable');
  const [notice, setNotice] = useState<'saved' | 'cleared' | null>(null);
  const locale = getLocale();
  const options = { locale };
  const href = saved ? hostedBookAddressHref(saved.address, locale) : null;
  return (
    <div
      className="contents"
      onClickCapture={(event) => {
        // The story supplies only the Router seam. Modified activation keeps the exact public link.
        const link = (event.target as Element).closest('a');
        if (
          !saved ||
          link?.getAttribute('href') !== href ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        if (current()) open(saved.address);
      }}
    >
      <HostedBookCheckpointControls
        locale={locale}
        chapter={page.kind === 'chapter'}
        saved={!unavailable && saved !== null}
        withheld={false}
        resume={!unavailable && saved && href ? { href, title: saved.title } : null}
        message={
          unavailable
            ? m.book_reader_progress_unavailable({}, options)
            : notice === 'saved'
              ? m.book_reader_checkpoint_saved({}, options)
              : notice === 'cleared'
                ? m.book_reader_checkpoint_cleared({}, options)
                : saved
                  ? null
                  : m.book_reader_checkpoint_none({}, options)
        }
        busy={false}
        blocked={false}
        isCurrent={current}
        {...(!unavailable && page.kind === 'chapter'
          ? {
              save: () => {
                if (!current()) return;
                setSaved({ address: page.address, title: page.title });
                setNotice('saved');
              },
            }
          : {})}
        {...(!unavailable && saved
          ? {
              clear: () => {
                if (!current()) return;
                setSaved(null);
                setNotice('cleared');
              },
            }
          : {})}
        {...(unavailable
          ? {
              retry: () => {
                if (current()) setUnavailable(false);
              },
            }
          : {})}
      />
    </div>
  );
}

/** A deliberately unsaved extension: checkpoint recovery must leave this local edit alone. */
function IllustrativeProgress({ current }: { current: () => boolean }) {
  const [amount, setAmount] = useState('4');
  return (
    <section aria-label={m.library_progress_measures_heading()} className="grid min-w-0 justify-items-start gap-3">
      {amount !== '3' ? (
        <p role="status" className="text-sm">
          {m.library_progress_draft_navigation_title()}
        </p>
      ) : null}
      <label className="grid gap-2 text-sm">
        {m.library_progress_amount()}
        <Input
          className="max-w-40"
          value={amount}
          onChange={(event) => {
            if (current()) setAmount(event.target.value);
          }}
        />
      </label>
      <Button
        variant="outline"
        className="min-h-11 whitespace-normal"
        onClick={() => {
          if (current()) setAmount('3');
        }}
      >
        {m.library_progress_draft_navigation_discard()}
      </Button>
    </section>
  );
}

function BookJourney({ state = 'nested', chapter = false, direct = 'first', checkpoint = 'none', startAtRoot = false }: JourneyProps) {
  const [runtime] = useState(() => {
    const book = createIllustrativeHostedBook(state, true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    return { book, client, navigation: createHostedBookNavigation() };
  });
  const [address, setAddress] = useState<BookAddress | null>(() =>
    chapter ? null : runtime.book.contents(state === 'nested' || startAtRoot ? null : illustrativeBookIds.nested),
  );
  runtime.navigation.bind(getLocale());
  const [contentsReturn, setContentsReturn] = useState<BookContentsAddress | null>(null);
  const [saved, setSaved] = useState<SavedReading | null>(null);
  const [focusOnRead, setFocusOnRead] = useState<HostedBookReaderProps['focusOnRead']>();
  useEffect(() => {
    let current = true;
    void Promise.all([
      chapter ? (direct === 'night' ? runtime.book.nightChapter() : runtime.book.chapter()) : null,
      checkpoint === 'saved' ? runtime.book.chapter(true) : null,
    ]).then(([opening, savedChapter]) => {
      if (!current) return;
      if (opening) setAddress(opening);
      if (savedChapter) setSaved({ address: savedChapter, title: 'Dawn, an echo / 再読' });
    });
    return () => {
      current = false;
    };
  }, [runtime, chapter, direct, checkpoint]);
  useEffect(() => () => {
    runtime.navigation.cancelFocus();
    runtime.client.clear();
  }, [runtime]);
  return (
    <QueryClientProvider client={runtime.client}>
      <main className="min-w-0">
        <aside className="mx-auto grid max-w-[52rem] gap-2 px-4 pt-4 text-xs text-muted-foreground sm:px-8">
          <p role="note">
            Illustrative native-format Content responses through the actual mapper and shared reader. Checkpoint
            controls use local examples of the installed contract. These are not native publication or save acceptance.
            Review manually; set the readerJourney story parameter to run the retained interaction assertions.
          </p>
          <Button
            className="min-h-11 justify-self-start text-xs"
            variant="ghost"
            onClick={() => runtime.book.replace()}
          >
            Replace publication / target / viewer admission
          </Button>
        </aside>
        {address ? (
          <HostedBookReader
            address={address}
            source={runtime.book.source}
            readingIdentity={runtime.book}
            locale={getLocale()}
            hrefForAddress={(target) => hostedBookAddressHref(target, getLocale(), address.kind === 'contents' ? address : contentsReturn)}
            contentsReturn={contentsReturn}
            contentsNavigation={runtime.navigation.contents}
            onNavigate={(target, origin, focus) => {
              runtime.navigation.captureFocus(focus);
              setFocusOnRead(runtime.navigation.focusOnRead());
              setContentsReturn(origin);
              setAddress(target);
            }}
            {...(focusOnRead ? { focusOnRead } : {})}
            {...(checkpoint === 'unavailable'
              ? {
                  renderProgress: (_page: BookChapterPage, current: () => boolean) => (
                    <IllustrativeProgress current={current} />
                  ),
                }
              : {})}
            renderCheckpoint={(page, current) => (
              <IllustrativeCheckpoint
                page={page}
                current={current}
                initialState={checkpoint}
                saved={saved}
                setSaved={setSaved}
                open={(target) => {
                  setFocusOnRead({ owner: document.activeElement, focus: { kind: 'heading' } });
                  setAddress(target);
                }}
              />
            )}
          />
        ) : (
          <p role="status">{m.book_reader_loading()}</p>
        )}
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Books/Hosted Book reader',
  id: 'interfaces-hosted-book-reader',
  component: BookJourney,
  parameters: { layout: 'fullscreen', readerJourney: false },
  render: (args) => <BookJourney key={`${args.state}:${args.chapter}:${args.direct}:${args.checkpoint}:${args.startAtRoot}`} {...args} />,
  args: { state: 'nested', chapter: false },
} satisfies Meta<typeof BookJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function nestedJourney({
  canvasElement,
  parameters,
}: {
  canvasElement: HTMLElement;
  parameters: Record<string, unknown>;
}) {
  if (!parameters.readerJourney) return;
  const canvas = within(canvasElement);
  await canvas.findByText('Part I · The journey');
  await userEvent.click(canvas.getByRole('link', { name: `${m.book_reader_contents()} · Part I · The journey` }));
  await userEvent.click(await canvas.findByRole('link', { name: `${m.book_reader_contents()} · The observatory` }));
  const first = await canvas.findByRole('link', { name: `${m.book_reader_open_chapter()} · Dawn / 黎明` });
  await userEvent.click(first);
  await canvas.findByRole('heading', { level: 1, name: 'Dawn / 黎明' });
  await expect(canvas.getByRole('article')).toHaveTextContent('The keeper opened the eastern shutters.');
  await userEvent.click(canvas.getAllByRole('button', { name: m.book_reader_contents() })[0]!);
  await expect(
    await canvas.findByRole('link', { name: `${m.book_reader_open_chapter()} · Dawn / 黎明` }),
  ).toHaveAttribute('aria-current', 'location');
}

async function failedPage({
  canvasElement,
  parameters,
}: {
  canvasElement: HTMLElement;
  parameters: Record<string, unknown>;
}) {
  if (!parameters.readerJourney) return;
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_more() }));
  await canvas.findByText(m.book_reader_unavailable());
  await userEvent.click(canvas.getByRole('button', { name: m.book_reader_retry() }));
  await canvas.findByText('Dawn, an echo / 再読');
  await expect(canvas.getByText(m.book_reader_level_end())).toBeVisible();
}

// The same named behavior states use the locale/theme globals and both screenshot widths (390 / 1280).
export const NestedContents: Story = { play: nestedJourney };
export const ExactChapter: Story = { args: { chapter: true, direct: 'night' } };
export const SavedContinue: Story = { args: { checkpoint: 'saved' } };
export const IndependentCheckpointFailure: Story = { args: { chapter: true, checkpoint: 'unavailable' } };
export const SparseContinuation: Story = { args: { state: 'sparse' } };
export const FailedPageRecovery: Story = { args: { state: 'failed-page' }, play: failedPage };
export const MovedOccurrence: Story = { args: { state: 'moved', chapter: true } };
export const UnavailableNavigation: Story = { args: { state: 'unavailable-navigation', chapter: true } };
export const RetiredReading: Story = {
  args: { chapter: true },
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await canvas.findByRole('article');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace publication / target / viewer admission' }));
    await canvas.findByText(m.book_reader_changed());
    await expect(canvas.queryByRole('article')).toBeNull();
  },
};

async function pageRoundTrip({ canvasElement, parameters }: { canvasElement: HTMLElement; parameters: Record<string, unknown> }) {
  if (!parameters.readerJourney) return;
  const canvas = within(canvasElement);
  await canvas.findByText('Dawn / 黎明');
  await expect(canvas.queryByRole('link', { name: m.book_reader_previous_page() })).toBeNull();
  await userEvent.click(canvas.getByRole('link', { name: m.book_reader_more() }));
  await canvas.findByText('Dawn, an echo / 再読');
  await userEvent.click(canvas.getByRole('link', { name: m.book_reader_previous_page() }));
  await canvas.findByText('Dawn / 黎明');
  await userEvent.click(canvas.getByRole('link', { name: m.book_reader_more() }));
  const chapter = await canvas.findByRole('link', { name: `${m.book_reader_open_chapter()} · Dawn, an echo / 再読` });
  const frozen = new URL(chapter.getAttribute('href')!, window.location.origin);
  await expect(frozen.searchParams.get('returnCursor')).toBe('illustrative:opaque/+page=2');
  await expect(frozen.searchParams.get('release')).toBe(illustrativeBookIds.release);
  await userEvent.click(chapter);
  await canvas.findByRole('article');
  await userEvent.click(canvas.getAllByRole('button', { name: m.book_reader_contents(), exact: true })[0]!);
  await canvas.findByText('Dawn, an echo / 再読');
  await expect(canvas.getByRole('link', { name: m.book_reader_previous_page() })).toBeVisible();
  await expect(canvas.queryByText('Dawn / 黎明')).toBeNull();
}

export const MultipleContentsPages: Story = { args: { state: 'multiple-pages' }, play: pageRoundTrip };
export const NestedLevelReturn: Story = {
  args: { state: 'multiple-pages', startAtRoot: true },
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: `${m.book_reader_contents()} · Part I · The journey` }));
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: `${m.book_reader_contents()} · The observatory` }));
    await canvas.findByText('Dawn / 黎明');
    await userEvent.click(canvas.getByRole('link', { name: 'Part I · The journey', exact: true }));
    await canvas.findByText('The observatory');
    await expect(new URL(canvas.getByRole('link', { name: m.book_reader_first_page() }).getAttribute('href')!, window.location.origin).searchParams.get('parent')).toBe(illustrativeBookIds.part);
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_root() }));
    await canvas.findByText('Part I · The journey');
    await expect(canvas.queryByText('Part II · The coast, the town, and the long way home / 海岸、町、そして帰り道')).toBeNull();
  },
};
export const FailedPreviousRetry: Story = {
  args: { state: 'failed-previous' },
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_more() }));
    await canvas.findByText('Dawn, an echo / 再読');
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_more() }));
    await canvas.findByText(m.book_reader_empty());
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_previous_page() }));
    await canvas.findByText(m.book_reader_unavailable());
    await expect(canvas.getByText(m.book_reader_contents_recovery())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.book_reader_retry() }));
    await canvas.findByText('Dawn, an echo / 再読');
    await expect(canvas.queryByText('Dawn / 黎明')).toBeNull();
  },
};
