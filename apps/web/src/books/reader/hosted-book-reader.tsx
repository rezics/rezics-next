import { QueryClientContext } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, List, Pin, PinOff } from 'lucide-react';
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
import { ShellContextNavigation } from '../../shell/contextual-navigation';
import { BookOutlineView } from './outline';
import { PostReadingBody } from '../../threads/post-reading-body';
import type { BookContentsMovement, BookContentsNavigation } from './contents-navigation';
import { createCheckpointPosition, type CheckpointPosition } from './checkpoint-position';
import { createBookReader, type BookReader, type BookReaderNavigation, type BookReaderFocus } from './reader-state';
import {
  uninstalledHostedBookSource,
  samePublication,
  type BookAddress,
  type BookPage,
  type BookChapterPage,
  type BookContentsPage,
  type BookContentsAddress,
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
  hrefForAddress?: (address: BookAddress, contentsReturn?: BookContentsAddress | null) => string | null;
  /** One bounded originating contents position supplied by the route. */
  contentsReturn?: BookContentsAddress | null;
  onNavigate?: BookReaderNavigation;
  onReload?: (focus?: BookReaderFocus) => void;
  /** Bounded coordinate memory owned and scoped by the route host. */
  contentsNavigation?: BookContentsNavigation;
  focusOnRead?: { focus: BookReaderFocus; owner: Element | null };
  /** Native Library checkpoint controls share the admitted page lifetime. */
  renderCheckpoint?: (page: BookPage, isCurrent: () => boolean, position: CheckpointPosition) => ReactNode;
  /** An admitted region rendered by the existing Commerce progress/resume owner. */
  renderProgress?: (page: BookChapterPage, isCurrent: () => boolean) => ReactNode;
};

/** A mounted reader usable with a supplied native projection source, without a second Studio/editor. */
export function HostedBookReader({
  address,
  source = uninstalledHostedBookSource,
  locale = getLocale(),
  readingIdentity,
  contentsReturn,
  contentsNavigation,
  onNavigate,
  onReload,
  focusOnRead,
  ...props
}: HostedBookReaderProps) {
  const client = useContext(QueryClientContext);
  const session = useMemo(() => readerSessionSource(client), [client]);
  const addressKey = JSON.stringify(address);
  const boundary = useRef({ source, addressKey, locale, readingIdentity, publication: address.publication });
  const former = boundary.current;
  if (
    former.locale !== locale ||
    !samePublication(former.publication, address.publication) ||
    (former.addressKey === addressKey && (former.source !== source || former.readingIdentity !== readingIdentity))
  )
    contentsNavigation?.retire();
  boundary.current = { source, addressKey, locale, readingIdentity, publication: address.publication };
  const readLocale = useCallback(() => locale, [locale]);
  const owner = useMemo(() => ({}), [source, addressKey, locale, readingIdentity]);
  const incarnation = useRef({ owner, generation: 0 });
  if (incarnation.current.owner !== owner)
    incarnation.current = { owner, generation: incarnation.current.generation + 1 };
  const route = useReaderVisit(`${addressKey}:${incarnation.current.generation}`, locale, readLocale);
  const [reopening, setReopening] = useState<{ owner: object; address: BookAddress } | null>(null);
  const openingAddress = reopening?.owner === owner ? reopening.address : address;
  const reader = useMemo(() => {
    const sessionVersion = session.snapshot();
    return createBookReader(
      source,
      openingAddress,
      locale,
      () => route.current() && session.snapshot() === sessionVersion,
      {
        ...(contentsNavigation !== undefined ? { contentsNavigation } : {}),
        ...(contentsReturn !== undefined ? { contentsReturn } : {}),
        ...(onNavigate !== undefined ? { navigate: onNavigate } : {}),
        ...(onReload !== undefined ? { reload: onReload } : {}),
        ...(focusOnRead !== undefined ? { initialFocus: focusOnRead.focus } : {}),
      },
    );
  }, [source, addressKey, locale, readingIdentity, session, route, reopening, owner, contentsNavigation]);
  const previous = useRef(reader);
  if (previous.current !== reader) previous.current.retire();
  previous.current = reader;
  useLayoutEffect(() => {
    const stopSession = session.subscribe(() => {
      contentsNavigation?.retire();
      reader.retire();
    });
    const disconnect = reader.connect();
    return () => {
      stopSession();
      disconnect();
    };
  }, [reader, session, contentsNavigation]);
  useLayoutEffect(() => {
    if (!route.current()) reader.retireBoundary();
  });
  return (
    <BookReaderView
      {...props}
      reader={reader}
      locale={locale}
      {...(focusOnRead !== undefined ? { focusOwner: focusOnRead.owner } : {})}
      restart={() => {
        if (onReload) {
          onReload();
          return;
        }
        if (route.current()) setReopening({ owner, address: reader.getSnapshot().address });
      }}
    />
  );
}

type ViewProps = Pick<HostedBookReaderProps, 'hrefForAddress' | 'renderProgress' | 'renderCheckpoint'> & {
  reader: BookReader;
  locale: string;
  restart: () => void;
  focusOwner?: Element | null;
};

function BookReaderView({
  reader,
  locale,
  restart,
  hrefForAddress,
  renderProgress,
  renderCheckpoint,
  focusOwner,
}: ViewProps) {
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const options = { locale: locale as never };
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const intent = useMemo<{ current: { owner: Element | null } | null }>(
    () => ({ current: focusOwner === undefined ? null : { owner: focusOwner } }),
    [reader],
  );
  const [pinNavigation, setPinNavigation] = useState(true);
  const page = state.page;
  const isPageCurrent = useCallback(
    () => reader.current() && reader.getSnapshot() === state && state.state === 'ready',
    [reader, state],
  );
  const checkpointPosition = useMemo(
    () => createCheckpointPosition(page, article, isPageCurrent),
    [page, isPageCurrent],
  );
  const act = (action: (focus: BookReaderFocus) => void, keyboard = true) => {
    if (!reader.current() || reader.getSnapshot() !== state) return;
    intent.current = keyboard ? { owner: document.activeElement } : null;
    action(keyboard ? { kind: 'heading' } : null);
  };
  const navigate = (address: BookAddress, movement: BookContentsMovement = 'level', keyboard = true) =>
    act((focus) => {
      if (address.kind === 'chapter') reader.openChapter(address, focus);
      else reader.openContents(address, movement, focus);
    }, keyboard);
  const currentPage = useRef(page);
  currentPage.current = page;

  useEffect(() => {
    // Changing focus during a request cancels its later focus transfer.
    const moved = (event: FocusEvent) => {
      if (!intent.current) return;
      const owner = intent.current.owner;
      if (event.target !== owner && !(event.target === document.body && !owner?.isConnected)) intent.current = null;
    };
    const cancel = () => {
      intent.current = null;
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('blur', cancel);
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
  useLayoutEffect(() => checkpointPosition.connect(), [checkpointPosition]);

  const labels = {
    contents: m.book_reader_contents({}, options),
    open: m.book_reader_open_chapter({}, options),
    part: m.book_reader_part({}, options),
    chapter: m.book_reader_chapter({}, options),
    unavailable: m.book_reader_unavailable({}, options),
  };
  const destination: BookDestination = (target, title, extra) => {
    const selected =
      target.kind === 'contents' && state.address.selection
        ? { ...target, selection: state.address.selection }
        : target;
    const address =
      selected.kind === 'contents' ? reader.resolveContents(selected, extra?.movement ?? 'level') : selected;
    const origin = address.kind === 'chapter' ? reader.outline.origin(address.selection.occurrenceId) : null;
    const supplied = hrefForAddress?.(address, origin ? { ...origin, selection: address.selection } : undefined);
    // Only the host's origin-local canonical addresses can become native links.
    const href = supplied?.startsWith('/') && !supplied.startsWith('//') && !/[\\\s]/.test(supplied) ? supplied : null;
    const appearance = extra?.appearance ?? 'control';
    const variant = appearance === 'control' ? 'outline' : 'ghost';
    const className = `${control} ${
      appearance === 'breadcrumb'
        ? 'min-w-0 shrink justify-start px-1.5 py-1 font-normal text-muted-foreground hover:text-foreground hover:underline underline-offset-4'
        : appearance === 'row'
          ? 'w-full justify-between gap-3 rounded-md px-3 py-3 text-base font-normal'
          : appearance === 'step'
            ? 'w-full flex-col items-start justify-center gap-1 px-3 py-2 font-normal'
            : ''
    } ${extra?.selected ? 'bg-muted font-semibold text-foreground' : ''}`;
    const ref = (element: HTMLElement | null) => {
      if (!extra?.row) return;
      if (element) rows.current.set(extra.row, element);
      else rows.current.delete(extra.row);
    };
    return href ? (
      <a
        href={href}
        ref={ref}
        className={buttonVariants({ variant, className })}
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
          navigate(address, extra?.movement, event.detail === 0);
        }}
      >
        {title}
      </a>
    ) : (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        className={className}
        aria-current={extra?.selected ? 'location' : undefined}
        onClick={(event) => navigate(address, extra?.movement, event.detail === 0)}
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
    const Icon = forward ? ArrowRight : ArrowLeft;
    if (value.state === 'available')
      return destination(
        value.address,
        <>
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Icon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
            {label}
          </span>
          <span className={pinNavigation ? 'sr-only' : 'block text-sm text-muted-foreground'}>
            <bdi>{value.title}</bdi>
          </span>
        </>,
        { appearance: 'step' },
      );
    return (
      <div className="grid min-w-0 content-center gap-1 px-3 py-2 text-sm text-muted-foreground" aria-disabled="true">
        <span className="font-medium">{label}</span>
        <span className={pinNavigation && value.state === 'end' ? 'sr-only' : 'block text-xs'}>
          {value.state === 'unavailable'
            ? m.book_reader_navigation_unavailable({}, options)
            : forward
              ? m.book_reader_last({}, options)
              : m.book_reader_first({}, options)}
        </span>
      </div>
    );
  };
  const title =
    page?.title ??
    (state.address.kind === 'contents' ? m.book_reader_contents({}, options) : m.book_reader_title({}, options));
  const rootContents = page
    ? {
        kind: 'contents' as const,
        publication: page.address.publication,
        parentOccurrenceId: null,
        cursor: null,
        selection: page.address.selection,
      }
    : null;
  const rootPage = page?.kind === 'contents' && page.address.parentOccurrenceId === null;
  return (
    <>
      <ShellContextNavigation label={labels.contents}>
        <BookOutlineView
          reader={reader}
          locale={locale}
          page={page}
          selection={state.address.selection}
          destination={destination}
          registerRow={(id, element) => {
            if (element) rows.current.set(id, element);
            else rows.current.delete(id);
          }}
        />
      </ShellContextNavigation>
      <section
        ref={root}
        aria-labelledby={headingId}
        aria-busy={state.state === 'loading'}
        className="mx-auto grid w-full min-w-0 max-w-[52rem] gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6 sm:gap-8 sm:px-8 sm:pt-10"
        lang={locale}
        data-slot="hosted-book-reader"
        data-reading-mode={pinNavigation ? 'pinned' : 'flow'}
      >
        <header className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
          {page && !rootPage ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              <bdi>{page.publicationTitle}</bdi>
            </p>
          ) : null}
          {page && rootContents ? (
            <nav aria-label={m.book_reader_context({}, options)} className="-mx-1.5">
              <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
                <li className="min-w-0 max-w-full">
                  {destination(rootContents, m.book_reader_root({}, options), { appearance: 'breadcrumb' })}
                </li>
                {page.ancestors.map((ancestor) => (
                  <li key={ancestor.occurrenceId} className="flex min-w-0 max-w-full items-center gap-1">
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
                    />
                    {destination(ancestor.contents, <bdi>{ancestor.title}</bdi>, { appearance: 'breadcrumb' })}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <div className="grid min-w-0 gap-2">
            {page ? (
              <p className="text-xs font-medium text-muted-foreground">
                {page.kind === 'chapter' ? labels.chapter : labels.contents}
              </p>
            ) : null}
            <h1
              ref={heading}
              id={headingId}
              tabIndex={-1}
              className={`text-pretty text-3xl font-semibold leading-tight tracking-tight sm:text-4xl ${focusable}`}
            >
              <bdi>{title}</bdi>
            </h1>
          </div>
        </header>
        {page?.kind === 'chapter' ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b pb-3">
            <Button
              className={`${control} gap-2 px-2`}
              variant="ghost"
              onClick={(event) => act((focus) => reader.openContents(undefined, 'exact', focus), event.detail === 0)}
            >
              <List aria-hidden="true" className="size-4 shrink-0" />
              {labels.contents}
            </Button>
            <Button
              className={`${control} gap-2 px-2 text-muted-foreground`}
              variant="ghost"
              aria-pressed={pinNavigation}
              onClick={() => setPinNavigation((value) => !value)}
            >
              {pinNavigation ? (
                <PinOff aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <Pin aria-hidden="true" className="size-4 shrink-0" />
              )}
              {pinNavigation ? m.book_reader_hide_controls({}, options) : m.book_reader_show_controls({}, options)}
            </Button>
          </div>
        ) : null}
        {page && renderCheckpoint ? (
          <ProgressRegion
            key={JSON.stringify(page.address)}
            unavailable={m.book_reader_progress_unavailable({}, options)}
          >
            <CheckpointOwner
              render={renderCheckpoint}
              page={page}
              current={isPageCurrent}
              position={checkpointPosition}
            />
          </ProgressRegion>
        ) : null}
        {page?.kind === 'chapter' ? (
          <>
            <article
              ref={article}
              aria-labelledby={headingId}
              lang={page.language ?? ''}
              dir={page.direction}
              tabIndex={-1}
              className={`min-w-0 py-2 sm:py-4 ${focusable}`}
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
              <details className="group min-w-0 border-t pt-3">
                <summary
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-medium ${focusable}`}
                >
                  {m.book_reader_progress_review({}, options)}
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
                </summary>
                <div className="min-w-0 py-3">
                  <ProgressRegion
                    key={JSON.stringify(page.address)}
                    unavailable={m.book_reader_progress_unavailable({}, options)}
                  >
                    <ProgressOwner render={renderProgress} page={page} current={isPageCurrent} />
                  </ProgressRegion>
                </div>
              </details>
            ) : null}
            <nav
              aria-label={m.book_reader_navigation({}, options)}
              className={`${pinNavigation ? 'sticky bottom-0 z-10 shadow-sm' : ''} grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-1 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] pt-2 [overflow-wrap:anywhere]`}
            >
              {step(page.previous, false)}
              <Button
                variant="ghost"
                className={`${control} self-center px-2`}
                onClick={(event) => act((focus) => reader.openContents(undefined, 'exact', focus), event.detail === 0)}
              >
                {labels.contents}
              </Button>
              {step(page.next, true)}
            </nav>
          </>
        ) : page?.kind === 'contents' ? (
          <Contents page={page} locale={locale} destination={destination} />
        ) : (
          <div className="grid justify-items-start gap-4 border-y py-6">
            {state.address.kind === 'contents' && state.state !== 'retired' ? (
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                {m.book_reader_contents_recovery({}, options)}
              </p>
            ) : null}
            <p role="status" className="max-w-prose leading-relaxed text-muted-foreground">
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
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  className={control}
                  variant="outline"
                  onClick={(event) => {
                    if (state.state === 'retired') {
                      intent.current = event.detail === 0 ? { owner: document.activeElement } : null;
                      restart();
                    } else act((focus) => reader.retry(focus), event.detail === 0);
                  }}
                >
                  {m.book_reader_retry({}, options)}
                </Button>
                {state.state !== 'retired' ? (
                  <>
                    {state.address.kind === 'contents' ? (
                      destination({ ...state.address, cursor: null }, m.book_reader_first_page({}, options), {
                        movement: 'first',
                      })
                    ) : (
                      <Button
                        className={control}
                        variant="ghost"
                        onClick={(event) =>
                          act((focus) => reader.openContents(undefined, 'exact', focus), event.detail === 0)
                        }
                      >
                        {labels.contents}
                      </Button>
                    )}
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
    </>
  );
}

export type BookDestination = (
  address: BookAddress,
  title: ReactNode,
  extra?: {
    selected?: boolean;
    row?: string;
    appearance?: 'control' | 'breadcrumb' | 'row' | 'step';
    movement?: BookContentsMovement;
  },
) => ReactNode;

function Contents({
  page,
  locale,
  destination,
}: {
  page: BookContentsPage;
  locale: string;
  destination: BookDestination;
}) {
  const options = { locale: locale as never };
  return page.selected && page.selected.state !== 'unavailable' ? (
    <div className="grid min-w-0 justify-items-start gap-2 border-s-2 border-foreground/30 ps-4">
      {destination(page.selected.chapter, m.book_reader_return_chapter({}, options))}
      {page.selected.state === 'moved' ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">{m.book_reader_moved({}, options)}</p>
          {destination(page.selected.contents, m.book_reader_current_location({}, options), { movement: 'exact' })}
        </>
      ) : null}
    </div>
  ) : page.selected?.state === 'unavailable' ? (
    <p role="status" className="text-sm text-muted-foreground">
      {m.book_reader_selection_unavailable({}, options)}
    </p>
  ) : null;
}

function CheckpointOwner({
  render,
  page,
  current,
  position,
}: {
  render: NonNullable<HostedBookReaderProps['renderCheckpoint']>;
  page: BookPage;
  current: () => boolean;
  position: CheckpointPosition;
}) {
  return render(page, current, position);
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
