import { ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { readPostHistory } from './reads';
import {
  historicalBindingCurrent,
  sameHistoricalReadBinding,
  type HistoricalReaderSource,
} from './historical-reader-provenance';
import { historySessionReady, PostHistoryLifetime, postHistorySessionSource } from './post-history-lifetime';

import { HistoryCurrentContext } from './post-history-current-context';
import { RevisionHistoryNavigation } from './revision-history-navigation';
import {
  consumeHistoryReturnCommand,
  createHistoryReturnReceipt,
  historyReturnTargetCurrent,
  parseHistoryReturnIntent,
  retireHistoryReturnReceipt,
  type HistoryReturnIntent,
  type HistoryReturnTarget,
} from './revision-return/history-return';
export { RevisionEntry } from './revision-history-entry';

type ContinuationIntent = { connection: number; element: HTMLButtonElement };
type ContinuationBoundary = { connection: number; revisionId: string | null; intent: ContinuationIntent };

type PostHistoryProps = {
  postId: string;
  threadId?: string;
  /** Router-owned origin for the real thread route; standalone examples may use the browser location. */
  returnOrigin?: { pathname: string; search: string };
  navigateToExactRevision?: (identity: { postId: string; revisionId: string }, historyReturn: string) => void;
  exposure?: unknown;
  viewerId?: string;
  readAuthority?: object;
  review?: boolean;
  /** Allows the same producer's control and expanded region to participate in the post footer. */
  className?: string;
};

const noSubscription = () => () => {};
const serverRevision = () => 0;

/** A disclosure belongs to its original caller and actual browser session cache lifetime. */
export function PostHistory(props: PostHistoryProps) {
  const { postId, threadId, exposure, viewerId, readAuthority, returnOrigin } = props;
  const client = useContext(QueryClientContext);
  const source = client && typeof window !== 'undefined' ? postHistorySessionSource(client) : undefined;
  const observation = source?.read();
  const revision = useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.revision ?? serverRevision,
    serverRevision,
  );
  const locale = getLocale();
  const credentialMode =
    observation?.state === 'signed-in' && observation.subject
      ? 'session'
      : !source && viewerId
        ? 'session'
        : 'anonymous';
  const binding = useMemo(
    () => ({ postId, threadId, exposure, viewerId, readAuthority, source, revision, locale, credentialMode }),
    [postId, threadId, exposure, viewerId, readAuthority, source, revision, locale, credentialMode],
  );
  const current = useRef(binding);
  current.current = binding;
  const lifetime = useMemo(
    () =>
      new PostHistoryLifetime(
        () => current.current === binding && (!source || source.revision() === revision),
        source?.subscribe,
      ),
    [binding, source, revision],
  );
  const previous = useRef(lifetime);
  if (previous.current !== lifetime) {
    // The parent is already replacing the old subtree; clear it without notifying during render.
    previous.current.retire(false);
    previous.current = lifetime;
  }
  useLayoutEffect(lifetime.connect, [lifetime]);
  const pathname = returnOrigin?.pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname);
  const locationSearch = returnOrigin?.search ?? (typeof window === 'undefined' ? '' : window.location.search);
  const parsedReturnIntent = useMemo(() => parseHistoryReturnIntent(locationSearch), [locationSearch]);
  const returnIntent = parsedReturnIntent?.postId === postId ? parsedReturnIntent : undefined;
  return (
    <HistoryDisclosure
      key={lifetime.id}
      {...props}
      lifetime={lifetime}
      source={source}
      locale={locale}
      credentialMode={credentialMode}
      ready={() => historySessionReady(source, viewerId)}
      pathname={pathname}
      locationSearch={locationSearch}
      returnIntent={returnIntent}
    />
  );
}

/** A bounded, cursor-paged view of the immutable revisions returned by the native post history API. */
function HistoryDisclosure({
  postId,
  threadId,
  viewerId,
  review = false,
  className = 'mt-3',
  lifetime,
  source,
  locale,
  credentialMode,
  ready,
  pathname,
  locationSearch,
  returnIntent,
  navigateToExactRevision,
}: PostHistoryProps & {
  lifetime: PostHistoryLifetime;
  source: HistoricalReaderSource | undefined;
  locale: string;
  credentialMode: 'anonymous' | 'session';
  ready: () => boolean;
  pathname: string;
  locationSearch: string;
  returnIntent: HistoryReturnIntent | undefined;
  navigateToExactRevision: PostHistoryProps['navigateToExactRevision'];
}) {
  const regionId = `post-history-${useId().replaceAll(':', '')}`;
  const [continuationStatus, setContinuationStatus] = useState<string | null>(null);
  const [additionStatus, setAdditionStatus] = useState<string | null>(null);
  const [returnState, setReturnState] = useState<
    'none' | 'loading' | 'failed' | 'lost' | 'missing' | 'restored' | 'unsupported'
  >('none');
  const [returnSelection, setReturnSelection] = useState<{
    postId: string;
    revisionId: string;
    pageGeneration: number;
    focusOwned: () => boolean;
  }>();
  const keyboardActivation = useRef<HTMLButtonElement | undefined>(undefined);
  const continuationIntent = useRef<ContinuationIntent | undefined>(undefined);
  const continuationBoundary = useRef<ContinuationBoundary | undefined>(undefined);
  const returnAttempt = useRef<{ target: HistoryReturnTarget; revisionId: string }>();
  const returnFocusOwned = useRef(false);
  const startedReturn = useRef<string>();
  const {
    open,
    loading,
    loaded,
    available,
    failedCursor,
    revisions,
    authors,
    mentions,
    subjects,
    reviewVotes,
    next,
    now,
    pageGeneration,
    context,
    cursor: admittedCursor,
  } = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  const connection = lifetime.ticket();
  const pageFailed = failedCursor !== undefined;
  const retryContext = context?.retry.state === 'same_cursor';
  const retryPage = !available || pageFailed || retryContext;
  const showHistoryAction = available ? next !== null || pageFailed || retryContext : loaded;
  const revisionIds = useMemo(() => revisions.map(({ revision }) => revision.revisionId), [revisions]);

  function openExactRevision(postId: string, revisionId: string) {
    if (
      !navigateToExactRevision ||
      !available ||
      !loaded ||
      loading ||
      !lifetime.ownsPage(connection, pageGeneration) ||
      !revisions.some((entry) => entry.revision.id === postId && entry.revision.revisionId === revisionId)
    )
      return;
    const token = createHistoryReturnReceipt({
      postId,
      revisionId,
      locale,
      credentialMode,
      source,
      readerId: lifetime.id,
      pageGeneration,
      historyCursor: admittedCursor,
      revisionIds,
      pathname,
      search: locationSearch,
    });
    if (!token) {
      setReturnState('unsupported');
      return;
    }
    navigateToExactRevision({ postId, revisionId }, token);
  }

  useLayoutEffect(() => {
    return () => {
      const pending = returnAttempt.current;
      if (!pending) return;
      queueMicrotask(() => {
        if (!lifetime.current()) retireHistoryReturnReceipt(pending.target.token);
      });
    };
  }, [lifetime]);

  useLayoutEffect(() => {
    const cancel = () => {
      keyboardActivation.current = undefined;
      continuationIntent.current = undefined;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  useLayoutEffect(() => {
    if (!returnIntent) return;
    const cancelFocus = () => {
      returnFocusOwned.current = false;
    };
    document.addEventListener('pointerdown', cancelFocus, true);
    document.addEventListener('focusin', cancelFocus, true);
    document.addEventListener('keydown', cancelFocus, true);
    window.addEventListener('blur', cancelFocus);
    return () => {
      document.removeEventListener('pointerdown', cancelFocus, true);
      document.removeEventListener('focusin', cancelFocus, true);
      document.removeEventListener('keydown', cancelFocus, true);
      window.removeEventListener('blur', cancelFocus);
    };
  }, [returnIntent?.revisionId, returnIntent?.token]);

  useLayoutEffect(() => {
    const pending = continuationBoundary.current;
    if (!pending) return;
    if (
      pending.connection !== connection ||
      !lifetime.ownsConnection(connection) ||
      pending.intent !== continuationIntent.current
    ) {
      continuationBoundary.current = undefined;
      continuationIntent.current = undefined;
      setContinuationStatus(null);
      return;
    }
    const boundary = document.getElementById(regionId)?.querySelector<HTMLElement>('[data-history-focus-boundary]');
    if (!boundary) {
      continuationBoundary.current = undefined;
      continuationIntent.current = undefined;
      setContinuationStatus(null);
      return;
    }
    continuationIntent.current = undefined;
    continuationBoundary.current = undefined;
    boundary.focus({ preventScroll: true });
  }, [connection, continuationStatus, lifetime, regionId, revisions]);

  async function load(cursor?: string, keyboardElement?: HTMLButtonElement) {
    const pendingReturn = returnAttempt.current;
    const returning =
      pendingReturn !== undefined &&
      pendingReturn.target.historyCursor === cursor &&
      historyReturnTargetCurrent(
        pendingReturn.target,
        postId,
        pendingReturn.revisionId,
        locale,
        credentialMode,
        source,
        pathname,
        locationSearch,
      );
    if (pendingReturn && !returning) {
      retireHistoryReturnReceipt(pendingReturn.target.token);
      returnAttempt.current = undefined;
      returnFocusOwned.current = false;
      setReturnSelection(undefined);
      setReturnState('lost');
      return;
    }
    setReturnSelection(undefined);
    if (returning) setReturnState('loading');
    else if (returnState !== 'none') setReturnState('none');
    continuationIntent.current = undefined;
    continuationBoundary.current = undefined;
    setContinuationStatus(null);
    setAdditionStatus(null);
    const keyboardOwner =
      cursor !== undefined && keyboardElement && document.activeElement === keyboardElement
        ? keyboardElement
        : undefined;
    const request = lifetime.begin(connection, source, postId, cursor, locale, credentialMode, viewerId);
    if (!request) return;
    const intent = keyboardOwner ? { connection, element: keyboardOwner } : undefined;
    continuationIntent.current = intent;
    try {
      // Fence the queued transport itself, before it can borrow replacement session credentials.
      await Promise.resolve();
      if (!lifetime.owns(request) || !historicalBindingCurrent(source, request.binding)) return;
      if (!ready()) {
        lifetime.resetDisclosure(connection);
        if (returning && pendingReturn) {
          retireHistoryReturnReceipt(pendingReturn.target.token);
          returnAttempt.current = undefined;
          returnFocusOwned.current = false;
          setReturnState('lost');
        }
        return;
      }
      const result = await readPostHistory({
        data: {
          postId,
          ...(cursor !== undefined ? { cursor } : {}),
          locale,
          credentialMode,
          binding: request.binding,
        },
      });
      if (!lifetime.owns(request)) return;
      const target = request.binding.target;
      const resultBinding = result.provenance?.binding;
      if (
        !resultBinding ||
        !sameHistoricalReadBinding(request.binding, resultBinding) ||
        target.kind !== 'post-history' ||
        target.postId !== postId ||
        target.cursor !== (cursor ?? null) ||
        target.locale !== locale ||
        target.credentialMode !== credentialMode ||
        !Number.isSafeInteger(result.provenance.responseGeneration) ||
        result.provenance.responseGeneration <= 0 ||
        !historicalBindingCurrent(source, request.binding, result.provenance.actualReader) ||
        !lifetime.acceptReader(request, result.provenance.actualReader)
      ) {
        console.error('History reader rejected its response binding', {
          target,
          resultBinding,
          responseGeneration: result.provenance?.responseGeneration,
          actualReader: result.provenance?.actualReader,
          bindingCurrent: historicalBindingCurrent(source, request.binding, result.provenance?.actualReader),
          requestOwned: lifetime.owns(request),
        });
        if (lifetime.owns(request)) lifetime.resetDisclosure(connection);
        if (returning && pendingReturn) {
          retireHistoryReturnReceipt(pendingReturn.target.token);
          returnAttempt.current = undefined;
          returnFocusOwned.current = false;
          setReturnState('lost');
        }
        return;
      }
      if (!result.data.available) {
        console.error('History reader returned an unavailable page');
        lifetime.failPage(request);
        if (returning) setReturnState('failed');
        return;
      }
      const page = result.data;
      if (threadId && page.context && page.context.conversation.id !== threadId) {
        lifetime.failPage(request);
        if (returning) setReturnState('failed');
        return;
      }
      if (cursor !== undefined && page.revisions.length > 0 && lifetime.snapshot().open) {
        setAdditionStatus(m.thread_history_page_loaded());
      }
      if (
        cursor !== undefined &&
        intent &&
        continuationIntent.current === intent &&
        lifetime.snapshot().open &&
        lifetime.ownsConnection(connection)
      ) {
        continuationBoundary.current = {
          connection,
          revisionId: page.revisions[0]?.revisionId ?? null,
          intent,
        };
        setContinuationStatus(
          page.revisions.length === 0
            ? page.next === null
              ? m.thread_history_complete()
              : m.thread_history_page_empty()
            : page.next === null
              ? m.thread_history_complete()
              : m.thread_history_page_loaded(),
        );
      }
      lifetime.acceptPage(request, page);
      if (returning && pendingReturn) {
        const index = page.revisions.findIndex(
          (revision) => revision.id === postId && revision.revisionId === pendingReturn.revisionId,
        );
        returnAttempt.current = undefined;
        if (index < 0) {
          retireHistoryReturnReceipt(pendingReturn.target.token);
          returnFocusOwned.current = false;
          setReturnState('missing');
        } else {
          retireHistoryReturnReceipt(pendingReturn.target.token);
          setReturnSelection({
            postId,
            revisionId: pendingReturn.revisionId,
            pageGeneration: request.read,
            focusOwned: () => returnFocusOwned.current,
          });
          setReturnState('restored');
        }
      }
    } catch (error) {
      console.error('History page request failed', error);
      lifetime.failPage(request);
      if (returning) setReturnState('failed');
    } finally {
      if (intent && continuationIntent.current === intent && continuationBoundary.current?.intent !== intent) {
        continuationIntent.current = undefined;
      }
      lifetime.finish(request);
    }
  }

  useLayoutEffect(() => {
    if (!returnIntent) return;
    const key = `${returnIntent.token}:${returnIntent.revisionId}`;
    if (startedReturn.current === key) return;
    startedReturn.current = key;
    const command = consumeHistoryReturnCommand({
      intent: returnIntent,
      locale,
      credentialMode,
      source,
      pathname,
      search: locationSearch,
    });
    if (!command) {
      setReturnState('lost');
      return;
    }
    returnAttempt.current = { target: command.target, revisionId: returnIntent.revisionId };
    returnFocusOwned.current = command.focusRequested;
    setReturnState('loading');
    lifetime.update(connection, (view) => ({ ...view, open: true }));
    void load(command.target.historyCursor);
  }, [
    connection,
    credentialMode,
    lifetime,
    locale,
    locationSearch,
    pathname,
    returnIntent?.revisionId,
    returnIntent?.token,
    source,
  ]);

  function restartHistory() {
    returnAttempt.current = undefined;
    returnFocusOwned.current = false;
    setReturnSelection(undefined);
    setReturnState('none');
    lifetime.update(connection, (view) => ({ ...view, open: true }));
    void load();
  }

  function toggle() {
    keyboardActivation.current = undefined;
    continuationIntent.current = undefined;
    continuationBoundary.current = undefined;
    setContinuationStatus(null);
    setAdditionStatus(null);
    if (!lifetime.ownsConnection(connection)) return;
    const view = lifetime.snapshot();
    const reveal = !view.open;
    lifetime.update(connection, (current) => ({ ...current, open: reveal }));
    if (reveal && !view.loaded && !view.loading) void load();
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
      >
        {open ? m.thread_history_hide() : m.thread_history_show()}
      </Button>
      <section
        id={regionId}
        hidden={!open}
        role="region"
        aria-label={m.thread_history_heading()}
        className="order-last mt-3 min-w-0 basis-full space-y-4 rounded-xl border border-border/70 bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
      >
        <ContentItemHeading level={3} className="text-base font-semibold">
          {m.thread_history_heading()}
        </ContentItemHeading>
        {available && context ? <HistoryCurrentContext context={context} authors={authors} now={now} /> : null}
        {loading && !loaded ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.thread_history_loading()}
          </p>
        ) : null}
        {available && loaded && !loading && revisions.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {next !== null
              ? m.thread_history_page_empty()
              : admittedCursor !== undefined
                ? m.thread_history_complete()
                : m.thread_history_empty()}
          </p>
        ) : null}
        {available && revisions.length > 0 ? (
          <RevisionHistoryNavigation
            key={`${connection}:${pageGeneration}`}
            active={open}
            entries={revisions}
            authors={authors}
            mentions={mentions}
            now={now}
            subjects={subjects}
            reviewVotes={reviewVotes}
            viewerId={viewerId}
            review={context ? context.conversation.kind === 'review' : review}
            hasMore={next !== null}
            isCurrent={() => lifetime.ownsPage(connection, pageGeneration)}
            boundaryRevisionId={
              continuationBoundary.current?.connection === connection
                ? continuationBoundary.current.revisionId
                : undefined
            }
            {...(navigateToExactRevision ? { openExactRevision } : {})}
            {...(returnSelection?.pageGeneration === pageGeneration ? { returnSelection } : {})}
          />
        ) : null}
        {returnState === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.revision_return_loading()}
          </p>
        ) : null}
        {returnState === 'restored' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.revision_return_restored()}
          </p>
        ) : null}
        {returnState === 'failed' ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {m.revision_return_failed()}
          </p>
        ) : null}
        {returnState === 'unsupported' ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted-foreground">
              {m.revision_return_unsupported()}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={restartHistory}
            >
              {m.revision_return_restart()}
            </Button>
          </div>
        ) : null}
        {returnState === 'missing' ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted-foreground">
              {m.revision_return_missing()}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={restartHistory}
            >
              {m.revision_return_restart()}
            </Button>
          </div>
        ) : null}
        {available && open && additionStatus ? (
          <p role="status" className="sr-only">
            {additionStatus}
          </p>
        ) : null}
        {continuationBoundary.current?.connection === connection && continuationBoundary.current.revisionId === null ? (
          <ContentItemHeading level={4} tabIndex={-1} data-history-focus-boundary className="font-semibold">
            {continuationStatus}
          </ContentItemHeading>
        ) : null}
        {continuationStatus &&
        continuationBoundary.current?.connection === connection &&
        continuationBoundary.current.revisionId !== null ? (
          <p role="status" className="sr-only">
            {continuationStatus}
          </p>
        ) : null}
        {!available || pageFailed ? (
          <p role="status" className="text-sm text-muted-foreground">
            {pageFailed ? m.thread_history_page_failed() : m.thread_history_unavailable()}
          </p>
        ) : null}
        {loading && loaded ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.thread_history_loading()}
          </p>
        ) : null}
        {showHistoryAction ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            disabled={loading}
            onKeyDown={(event) => {
              keyboardActivation.current =
                !event.repeat && (event.key === 'Enter' || event.key === ' ') ? event.currentTarget : undefined;
            }}
            onKeyUp={(event) => {
              const button = event.currentTarget;
              queueMicrotask(() => {
                if (keyboardActivation.current === button) keyboardActivation.current = undefined;
              });
            }}
            onClick={(event) => {
              const button = event?.currentTarget;
              const keyboard = event?.detail === 0 && keyboardActivation.current === button;
              keyboardActivation.current = undefined;
              if (returnState === 'lost' || returnState === 'missing') {
                restartHistory();
                return;
              }
              void load(
                retryContext ? admittedCursor : retryPage ? failedCursor : (next ?? undefined),
                keyboard ? button : undefined,
              );
            }}
          >
            {returnState === 'failed'
              ? m.revision_return_retry()
              : returnState === 'lost' || returnState === 'missing'
                ? m.revision_return_restart()
                : retryPage
                  ? m.exact_revision_retry()
                  : m.thread_history_more()}
          </Button>
        ) : null}
      </section>
      {returnState === 'lost' ? (
        <div className="mt-2 min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <p role="status" className="text-sm text-muted-foreground">
            {m.revision_return_lost()}
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={restartHistory}
          >
            {m.revision_return_restart()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
