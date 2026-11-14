import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { useEffect, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { HostedBookReader, type HostedBookReaderProps } from '../books/reader/hosted-book-reader';
import { HostedBookCheckpointControls } from '../books/reader/checkpoint-controls';
import { createHostedBookNavigation, HostedBookVisitView, parseHostedBookSearch, hostedBookSubjectHref, type HostedBookVisit } from '../books/reader/route';
import { readHostedDiscovery } from '../books/reader/discovery';
import { observeHostedBookVisit } from '../books/reader/visit';
import { hostedBookAddressHref } from '../books/reader/address';
import {
  createIllustrativeHostedBook,
  illustrativeBookIds,
  illustrativeBookCursor,
  illustrativeBookLastCursor,
  type IllustrativeBookState,
} from '../books/reader/illustrative-source';
import type {
  BookAddress,
  BookChapterAddress,
  BookChapterPage,
  BookContentsAddress,
  BookPage,
} from '../books/reader/source';
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

function BookJourney({
  state = 'nested',
  chapter = false,
  direct = 'first',
  checkpoint = 'none',
  startAtRoot = false,
}: JourneyProps) {
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
  useEffect(
    () => () => {
      runtime.navigation.cancelFocus();
      runtime.client.clear();
    },
    [runtime],
  );
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
            hrefForAddress={(target) =>
              hostedBookAddressHref(target, getLocale(), address.kind === 'contents' ? address : contentsReturn)
            }
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
  render: (args) => (
    <BookJourney
      key={`${args.state}:${args.chapter}:${args.direct}:${args.checkpoint}:${args.startAtRoot}`}
      {...args}
    />
  ),
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

async function pageRoundTrip({
  canvasElement,
  parameters,
}: {
  canvasElement: HTMLElement;
  parameters: Record<string, unknown>;
}) {
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
    await userEvent.click(
      await canvas.findByRole('link', { name: `${m.book_reader_contents()} · Part I · The journey` }),
    );
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: `${m.book_reader_contents()} · The observatory` }));
    await canvas.findByText('Dawn / 黎明');
    await userEvent.click(canvas.getByRole('link', { name: 'Part I · The journey', exact: true }));
    await canvas.findByText('The observatory');
    await expect(
      new URL(
        canvas.getByRole('link', { name: m.book_reader_first_page() }).getAttribute('href')!,
        window.location.origin,
      ).searchParams.get('parent'),
    ).toBe(illustrativeBookIds.part);
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_root() }));
    await canvas.findByText('Part I · The journey');
    await expect(
      canvas.queryByText('Part II · The coast, the town, and the long way home / 海岸、町、そして帰り道'),
    ).toBeNull();
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

type CatalogueState = 'multiple' | 'sparse' | 'direct' | 'failed' | 'selected';

/** Actual route composition and native response decoder, with only illustrative HTTP/Router seams. */
function CatalogueJourney({ state }: { state: CatalogueState }) {
  const [runtime] = useState(() => {
    const book = createIllustrativeHostedBook();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    return { book, client, navigation: createHostedBookNavigation() };
  });
  const locale = getLocale();
  const [href, setHref] = useState(() => hostedBookSubjectHref(illustrativeBookIds.post, locale,
    state === 'multiple' || state === 'selected' ? undefined : illustrativeBookCursor));
  const [retry, setRetry] = useState(0);
  const [visit, setVisit] = useState<{ href: string; locale: string; value: HostedBookVisit } | null>(null);
  const [transportReady, setTransportReady] = useState(false);
  useEffect(() => {
    let current = true;
    const fallback = globalThis.fetch;
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/v1/hostedCatalogues/${illustrativeBookIds.catalogue}`)) return fallback(input, init);
      const { api } = await runtime.book.ready;
      const query = Object.fromEntries(url.searchParams) as Parameters<typeof api.children>[1];
      const occurrence = url.pathname.split('/occurrences/')[1]?.split('/')[0];
      const result = url.pathname.endsWith('/children')
        ? await api.children(illustrativeBookIds.catalogue, query)
        : url.pathname.endsWith('/navigation')
          ? await api.navigate(illustrativeBookIds.catalogue, occurrence!, {
              ...query, direction: url.searchParams.get('direction') as 'previous' | 'next',
            })
          : url.pathname.endsWith('/metadata')
            ? await api.metadata(illustrativeBookIds.catalogue, occurrence!, query)
            : occurrence
              ? await api.resolve(illustrativeBookIds.catalogue, occurrence, query)
              : await api.catalogue(illustrativeBookIds.catalogue, query);
      return Response.json(result.state === 'ready' ? result.value : {}, { status: result.state === 'ready' ? 200 : 503 });
    };
    globalThis.fetch = transport;
    void runtime.book.ready.then(() => { if (current) setTransportReady(true); });
    return () => {
      current = false;
      if (globalThis.fetch === transport) globalThis.fetch = fallback;
      runtime.navigation.retire();
      runtime.client.clear();
    };
  }, [runtime]);
  useEffect(() => {
    if (!transportReady) return;
    const controller = new AbortController();
    const load = async () => {
      const url = new URL(href, window.location.origin);
      const search = parseHostedBookSearch(Object.fromEntries(url.searchParams));
      const catalogueId = decodeURIComponent(url.pathname.split('/').at(-2)!);
      let value: HostedBookVisit;
      if (search.view === 'catalogues') {
        const native = createKernelClient('https://illustrative-discovery.test', { fetch: async () => {
          if (state === 'failed' && retry === 0) {
            return Response.json({}, { status: 503 });
          }
          const row = { catalogueId: illustrativeBookIds.catalogue, revisionId: illustrativeBookIds.release,
            sourceRevisionId: illustrativeBookIds.structure, threadId: illustrativeBookIds.thread, kind: 'publication',
            title: 'The observatory, the coast, and the long way home / 天文台から海へ' };
          return Response.json({ subjectId: illustrativeBookIds.post,
            items: search.cursor === illustrativeBookCursor ? [] : [row],
            nextCursor: !search.cursor ? illustrativeBookCursor : search.cursor === illustrativeBookCursor ? illustrativeBookLastCursor : null,
          });
        } });
        const read = await readHostedDiscovery(native, null, catalogueId, search.cursor, controller.signal);
        value = read.state === 'ready' ? { state: 'catalogues', page: read.value } : read;
      } else {
        const { api } = await runtime.book.ready;
        value = await observeHostedBookVisit(api, { catalogueId, locale, search }, { kind: 'anonymous' }, m.book_reader_title());
      }
      if (!controller.signal.aborted) setVisit({ href, locale, value });
    };
    void load();
    return () => controller.abort();
  }, [runtime, state, href, locale, retry, transportReady]);
  const url = new URL(href, 'https://illustrative-reader.test');
  const location = { catalogueId: decodeURIComponent(url.pathname.split('/').at(-2)!),
    search: parseHostedBookSearch(Object.fromEntries(url.searchParams)) };
  return (
    <QueryClientProvider client={runtime.client}>
      <main className="min-w-0">
        <p role="note" className="mx-auto max-w-3xl px-4 pt-4 text-xs text-muted-foreground">
          Illustrative native-format pages through the actual chooser and reader composition. Each activation rereads
          its exact address. These examples do not establish native catalogue-to-reader acceptance.
        </p>
        {visit?.href === href && visit.locale === locale ? (
          <HostedBookVisitView visit={visit.value} locale={locale} navigation={runtime.navigation} location={location}
            navigate={(target) => {
              const path = new URL(target, window.location.origin).pathname;
              if (path !== new URL(href, window.location.origin).pathname) runtime.navigation.retireReading();
              setVisit(null);
              setHref(target);
            }}
            reload={() => { setVisit(null); setRetry((value) => value + 1); }} />
        ) : <p role="status" className="px-4 py-8">{m.book_reader_loading()}</p>}
      </main>
    </QueryClientProvider>
  );
}

export const MultipleCataloguePages: Story = {
  render: () => <CatalogueJourney state="multiple" />,
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_catalogues_more() }));
    await canvas.findByText(m.book_reader_catalogues_empty());
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_catalogues_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_catalogues_previous() }));
    await canvas.findByText(m.book_reader_catalogues_empty());
    await userEvent.click(canvas.getByRole('link', { name: m.book_reader_catalogues_first() }));
    await expect(canvas.queryByRole('link', { name: m.book_reader_catalogues_previous() })).toBeNull();
  },
};
export const SparseCatalogueContinuation: Story = { render: () => <CatalogueJourney state="sparse" /> };
export const DirectCatalogueEntry: Story = {
  render: () => <CatalogueJourney state="direct" />,
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await canvas.findByText(m.book_reader_catalogues_empty());
    await expect(canvas.queryByRole('link', { name: m.book_reader_catalogues_previous() })).toBeNull();
    await expect(canvas.getByRole('link', { name: m.book_reader_catalogues_first() })).toBeVisible();
  },
};
export const FailedCatalogueRetry: Story = {
  render: () => <CatalogueJourney state="failed" />,
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.book_reader_retry() }));
    await canvas.findByText(m.book_reader_catalogues_empty());
  },
};
export const SelectedCatalogueReturn: Story = {
  render: () => <CatalogueJourney state="selected" />,
  play: async ({ canvasElement, parameters }) => {
    if (!parameters.readerJourney) return;
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_catalogues_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: m.book_reader_catalogues_more() }));
    await userEvent.click(await canvas.findByRole('link', { name: /The observatory/ }));
    const back = await canvas.findByRole('link', { name: m.book_reader_catalogues_return() });
    await expect(new URL(back.getAttribute('href')!, window.location.origin).searchParams.get('cursor')).toBe(illustrativeBookLastCursor);
    await userEvent.click(back);
    await canvas.findByRole('link', { name: /The observatory/ });
    await expect(canvas.getByRole('link', { name: m.book_reader_catalogues_previous() })).toBeVisible();
  },
};
