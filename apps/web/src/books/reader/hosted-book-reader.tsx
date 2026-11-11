import { QueryClientContext } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  Component,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { readerSessionSource, useReaderVisit } from '../../reader/lifetime';
import { PostReadingBody } from '../../threads/post-reading-body';
import { createBookReader, type BookReader } from './reader-state';
import {
  sameSelection,
  uninstalledHostedBookSource,
  type BookAddress,
  type BookChapterPage,
  type BookContentsPage,
  type BookNavigation,
  type HostedBookSource,
} from './source';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';
const focusable = 'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring';
export type HostedBookReaderProps = {
  address: BookAddress;
  source?: HostedBookSource;
  locale?: string;
  /** Host publication/target/viewer admission identity; replacement retires equal body bytes. */
  readingIdentity: unknown;
  /** Optional installed canonical route mapper. The reader invents no Content URLs. */
  hrefForAddress?: (address: BookAddress) => string | null;
  /** An admitted region rendered by the existing Commerce progress/resume owner. */
  renderProgress?: (page: BookChapterPage, isCurrent: () => boolean) => ReactNode;
};

/** A mounted reader usable with a supplied native projection source, without a second Studio/editor. */
export function HostedBookReader({
  address,
  source = uninstalledHostedBookSource,
  locale = getLocale(),
  readingIdentity,
  ...props
}: HostedBookReaderProps) {
  const client = useContext(QueryClientContext);
  const session = useMemo(() => readerSessionSource(client), [client]);
  const addressKey = JSON.stringify(address);
  const readLocale = useCallback(() => locale, [locale]);
  const route = useReaderVisit(addressKey, locale, readLocale);
  const owner = useMemo(() => ({}), [source, addressKey, locale, readingIdentity]);
  const [reopening, setReopening] = useState<{ owner: object; address: BookAddress } | null>(null);
  const openingAddress = reopening?.owner === owner ? reopening.address : address;
  const reader = useMemo(() => {
    const sessionVersion = session.snapshot();
    return createBookReader(
      source,
      openingAddress,
      locale,
      () => route.current() && session.snapshot() === sessionVersion,
    );
  }, [source, addressKey, locale, readingIdentity, session, route, reopening, owner]);
  const previous = useRef(reader);
  if (previous.current !== reader) previous.current.retire();
  previous.current = reader;
  useLayoutEffect(() => {
    const stopSession = session.subscribe(() => reader.retire());
    const disconnect = reader.connect();
    return () => {
      stopSession();
      disconnect();
    };
  }, [reader, session]);
  useLayoutEffect(() => {
    if (!route.current()) reader.retire();
  });
  return (
    <BookReaderView
      {...props}
      reader={reader}
      locale={locale}
      restart={() => {
        if (route.current()) setReopening({ owner, address: reader.getSnapshot().address });
      }}
    />
  );
}

type ViewProps = Pick<HostedBookReaderProps, 'hrefForAddress' | 'renderProgress'> & {
  reader: BookReader;
  locale: string;
  restart: () => void;
};

function BookReaderView({ reader, locale, restart, hrefForAddress, renderProgress }: ViewProps) {
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const options = { locale: locale as never };
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const intent = useRef<{ owner: Element | null } | null>(null);
  const [showControls, setShowControls] = useState(true);
  const page = state.page;
  const isPageCurrent = useCallback(
    () => reader.current() && reader.getSnapshot() === state && state.state === 'ready',
    [reader, state],
  );
  const act = (action: () => void) => {
    if (!reader.current() || reader.getSnapshot() !== state) return;
    intent.current = { owner: document.activeElement };
    action();
  };
  const navigate = (address: BookAddress) =>
    act(() => {
      if (address.kind === 'chapter') reader.openChapter(address);
      else reader.openContents(address);
    });
  const currentPage = useRef(page);
  currentPage.current = page;

  useEffect(() => {
    // Changing focus during a request cancels its later focus transfer.
    const moved = (event: FocusEvent) => {
      if (intent.current && event.target !== intent.current.owner) intent.current = null;
    };
    document.addEventListener('focusin', moved);
    return () => {
      document.removeEventListener('focusin', moved);
      intent.current = null;
    };
  }, [reader]);
  useLayoutEffect(() => {
    if (!state.focus || !intent.current || state.state === 'loading') return;
    const pending = intent.current;
    const frame = requestAnimationFrame(() => {
      if (!reader.current() || reader.getSnapshot() !== state || intent.current !== pending) return;
      const active = document.activeElement;
      if (active !== pending.owner && !(active === document.body && !pending.owner?.isConnected)) return;
      const target =
        state.focus?.kind === 'occurrence' && state.focus.occurrenceId
          ? (rows.current.get(state.focus.occurrenceId) ?? heading.current)
          : heading.current;
      intent.current = null;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [reader, state]);
  useEffect(() => {
    setShowControls(true);
  }, [page]);

  const labels = {
    contents: m.book_reader_contents({}, options),
    open: m.book_reader_open_chapter({}, options),
    part: m.book_reader_part({}, options),
    chapter: m.book_reader_chapter({}, options),
    unavailable: m.book_reader_unavailable({}, options),
  };
  const destination = (target: BookAddress, title: ReactNode, extra?: { selected?: boolean; row?: string }) => {
    const address =
      target.kind === 'contents' && state.address.selection
        ? { ...target, selection: state.address.selection }
        : target;
    const supplied = hrefForAddress?.(address);
    // Only the host's origin-local canonical addresses can become native links.
    const href = supplied?.startsWith('/') && !supplied.startsWith('//') && !/[\\\s]/.test(supplied) ? supplied : null;
    const ref = (element: HTMLElement | null) => {
      if (!extra?.row) return;
      if (element) rows.current.set(extra.row, element);
      else rows.current.delete(extra.row);
    };
    return href ? (
      <a
        href={href}
        ref={ref}
        className={buttonVariants({ variant: 'outline', className: control })}
        aria-current={extra?.selected ? 'location' : undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          navigate(address);
        }}
      >
        {title}
      </a>
    ) : (
      <Button
        ref={ref}
        type="button"
        variant="outline"
        className={control}
        aria-current={extra?.selected ? 'location' : undefined}
        onClick={() => navigate(address)}
      >
        {title}
      </Button>
    );
  };

  useEffect(() => {
    if (page?.kind !== 'chapter') return;
    const key = (event: KeyboardEvent) => {
      if (
        !reader.current() ||
        currentPage.current !== page ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        window.getSelection()?.toString() ||
        !(event.target instanceof Element) ||
        !root.current?.contains(event.target) ||
        event.target.closest(
          'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="combobox"], [role="menu"], [role="listbox"], [role="tree"]',
        )
      )
        return;
      const direction =
        page.direction === 'auto' && root.current
          ? getComputedStyle(root.current.querySelector('article') ?? root.current).direction
          : page.direction;
      const next = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const previous = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      const step = event.key === next ? page.next : event.key === previous ? page.previous : null;
      if (step?.state !== 'available') return;
      event.preventDefault();
      intent.current = { owner: document.activeElement };
      reader.openChapter(step.address);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [reader, page]);

  const step = (value: BookNavigation, forward: boolean) => {
    const label = forward ? m.book_reader_next({}, options) : m.book_reader_previous({}, options);
    if (value.state === 'available')
      return destination(
        value.address,
        <>
          {label}
          <span className="block text-xs font-normal">{value.title}</span>
        </>,
      );
    return (
      <div className="min-w-0 rounded-lg border p-3 text-sm" aria-disabled="true">
        <span className="block font-medium">{label}</span>
        <span className="block text-muted-foreground">
          {value.state === 'unavailable'
            ? m.book_reader_navigation_unavailable({}, options)
            : forward
              ? m.book_reader_last({}, options)
              : m.book_reader_first({}, options)}
        </span>
      </div>
    );
  };
  const title = page?.title ?? m.book_reader_title({}, options);
  return (
    <section
      ref={root}
      aria-labelledby={headingId}
      aria-busy={state.state === 'loading'}
      className="mx-auto grid w-full min-w-0 max-w-5xl gap-6 px-4 py-6 sm:px-6"
      lang={locale}
      data-slot="hosted-book-reader"
      onFocusCapture={() => setShowControls(true)}
    >
      <header className="grid min-w-0 gap-3 [overflow-wrap:anywhere]">
        {page ? (
          <p className="text-sm font-medium text-muted-foreground">
            <bdi>{page.publicationTitle}</bdi>
          </p>
        ) : null}
        {page ? (
          <nav aria-label={m.book_reader_context({}, options)}>
            <ol className="flex flex-wrap gap-2">
              <li>
                {destination(
                  {
                    kind: 'contents',
                    publication: page.address.publication,
                    parentOccurrenceId: null,
                    cursor: null,
                    selection: page.address.selection,
                  },
                  m.book_reader_root({}, options),
                )}
              </li>
              {page.ancestors.map((ancestor) => (
                <li key={ancestor.occurrenceId}>{destination(ancestor.contents, <bdi>{ancestor.title}</bdi>)}</li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1 ref={heading} id={headingId} tabIndex={-1} className={`text-2xl font-semibold sm:text-3xl ${focusable}`}>
          <bdi>{title}</bdi>
        </h1>
      </header>
      {page?.kind === 'chapter' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button className={control} variant="outline" onClick={() => act(() => reader.openContents())}>
              {labels.contents}
            </Button>
            <Button
              className={control}
              variant="ghost"
              aria-pressed={showControls}
              onClick={() => setShowControls((value) => !value)}
            >
              {showControls ? m.book_reader_hide_controls({}, options) : m.book_reader_show_controls({}, options)}
            </Button>
          </div>
          <article
            aria-labelledby={headingId}
            lang={page.language ?? ''}
            dir={page.direction}
            tabIndex={-1}
            className={focusable}
          >
            <PostReadingBody
              {...page.body}
              documentLanguage={page.language}
              documentDirection={page.direction}
              readerIdentity={state}
              isReaderCurrent={isPageCurrent}
              wideVisitKey={JSON.stringify(page.address)}
              locale={locale}
            />
          </article>
          {renderProgress ? (
            <ProgressRegion
              key={JSON.stringify(page.address)}
              unavailable={m.book_reader_progress_unavailable({}, options)}
            >
              <ProgressOwner render={renderProgress} page={page} current={isPageCurrent} />
            </ProgressRegion>
          ) : null}
          <nav
            aria-label={m.book_reader_navigation({}, options)}
            className={`${showControls ? 'sticky' : ''} bottom-[env(safe-area-inset-bottom)] z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-2 rounded-xl bg-background/95 p-2 shadow-sm`}
          >
            {step(page.previous, false)}
            <Button variant="outline" className={control} onClick={() => act(() => reader.openContents())}>
              {labels.contents}
            </Button>
            {step(page.next, true)}
          </nav>
        </>
      ) : page?.kind === 'contents' ? (
        <Contents page={page} locale={locale} destination={destination} labels={labels} reader={reader} act={act} />
      ) : (
        <div className="grid justify-items-start gap-3 rounded-xl border p-5">
          <p role="status">
            {state.state === 'loading' || state.state === 'idle'
              ? m.book_reader_loading({}, options)
              : state.state === 'not-installed'
                ? m.book_reader_not_installed({}, options)
                : state.state === 'denied'
                  ? m.book_reader_denied({}, options)
                  : state.state === 'not-found'
                    ? m.book_reader_not_found({}, options)
                    : state.state === 'changed' || state.state === 'retired'
                      ? m.book_reader_changed({}, options)
                      : labels.unavailable}
          </p>
          {state.state !== 'loading' && state.state !== 'idle' && state.state !== 'not-installed' ? (
            <div className="flex flex-wrap gap-2">
              <Button
                className={control}
                variant="outline"
                onClick={() => {
                  if (state.state === 'retired') {
                    intent.current = { owner: document.activeElement };
                    restart();
                  } else act(() => reader.retry());
                }}
              >
                {m.book_reader_retry({}, options)}
              </Button>
              {state.state !== 'retired' ? (
                <>
                  <Button className={control} variant="outline" onClick={() => act(() => reader.openContents())}>
                    {labels.contents}
                  </Button>
                  {state.address.kind === 'contents' && state.address.selection
                    ? destination(
                        {
                          kind: 'chapter',
                          publication: state.address.publication,
                          selection: state.address.selection,
                        },
                        m.book_reader_return_chapter({}, options),
                      )
                    : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

type Destination = (address: BookAddress, title: ReactNode, extra?: { selected?: boolean; row?: string }) => ReactNode;
function Contents({
  page,
  locale,
  destination,
  labels,
  reader,
  act,
}: {
  page: BookContentsPage;
  locale: string;
  destination: Destination;
  labels: { contents: string; open: string; part: string; chapter: string; unavailable: string };
  reader: BookReader;
  act: (action: () => void) => void;
}) {
  const options = { locale: locale as never };
  return (
    <div className="grid min-w-0 gap-4">
      {page.selected && page.selected.state !== 'unavailable' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted p-3">
          {destination(page.selected.chapter, m.book_reader_return_chapter({}, options))}
          {page.selected.state === 'moved' ? (
            <>
              <p className="text-sm">{m.book_reader_moved({}, options)}</p>
              {destination(page.selected.contents, m.book_reader_current_location({}, options))}
            </>
          ) : null}
        </div>
      ) : page.selected?.state === 'unavailable' ? (
        <p role="status">{m.book_reader_selection_unavailable({}, options)}</p>
      ) : null}
      {!page.rows.length ? <p role="status">{m.book_reader_empty({}, options)}</p> : null}
      <ol className="grid min-w-0 gap-2">
        {page.rows.map((row) => {
          const selected = 'chapter' in row && sameSelection(row.chapter.selection, page.address.selection);
          return (
            <li
              key={row.occurrenceId}
              className="grid min-w-0 gap-2 rounded-xl border p-3 [overflow-wrap:anywhere]"
              data-occurrence={row.occurrenceId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {row.kind === 'container'
                    ? labels.part
                    : row.kind === 'container-with-body'
                      ? `${labels.part} · ${labels.chapter}`
                      : row.kind === 'chapter'
                        ? labels.chapter
                        : m.book_reader_selection_unavailable({}, options)}
                </span>
                <span className="font-medium">
                  <bdi>{row.title}</bdi>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {'chapter' in row
                  ? destination(
                      row.chapter,
                      <>
                        {labels.open}
                        <span className="sr-only"> · {row.title}</span>
                      </>,
                      { selected, row: row.occurrenceId },
                    )
                  : null}
                {'contents' in row
                  ? destination(
                      row.contents,
                      <>
                        {labels.contents}
                        <span className="sr-only"> · {row.title}</span>
                      </>,
                      row.kind === 'container' ? { row: row.occurrenceId } : undefined,
                    )
                  : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {page.address.cursor !== null
          ? destination({ ...page.address, cursor: null }, m.book_reader_first_page({}, options))
          : null}
        {page.continuation.state === 'more' ? (
          destination({ ...page.address, cursor: page.continuation.cursor }, m.book_reader_more({}, options))
        ) : page.continuation.state === 'end' ? (
          <p className="text-sm text-muted-foreground">{m.book_reader_level_end({}, options)}</p>
        ) : (
          <>
            <p role="status">{m.book_reader_navigation_unavailable({}, options)}</p>
            <Button className={control} variant="outline" onClick={() => act(() => reader.retry())}>
              {m.book_reader_retry({}, options)}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ProgressOwner({
  render,
  page,
  current,
}: {
  render: NonNullable<HostedBookReaderProps['renderProgress']>;
  page: BookChapterPage;
  current: () => boolean;
}) {
  return render(page, current);
}
class ProgressRegion extends Component<{ children: ReactNode; unavailable: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="status" className="text-sm text-muted-foreground">
        {this.props.unavailable}
      </p>
    ) : (
      this.props.children
    );
  }
}
