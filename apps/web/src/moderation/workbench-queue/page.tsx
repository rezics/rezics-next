import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { QueryClientContext } from '@tanstack/react-query';
import { csrfHeaders } from '../../threads/composer';
import { actionOnReport } from '../actions';
import { createPrivateReaderLifetime, privateReaderSessionSource } from '../private-reader-lifetime';
import type { ReportQueueAction } from '../reports-view-action';
import { createWorkbenchSelection, WorkbenchSelectionBoundary } from '../workbench-selection';
import { workbenchReadKey, workbenchSearch, workbenchWithoutContinuation, type WorkbenchSearch } from './scope';
import { loadWorkbench, type WorkbenchCase, type WorkbenchRead, type WorkbenchReader } from './read';
import { WorkbenchView } from './view';
import {
  isWorkbenchHistoryTransition,
  workbenchQueueWindowHistory,
  workbenchReaderFence,
  type WorkbenchWindowMove,
} from './window-history';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

const nativeWorkbenchRead: WorkbenchReader = (search, signal) =>
  loadWorkbench({ data: search, ...(signal ? { signal } : {}) });

export function WorkbenchPage({
  page,
  search,
  onSearch,
  onRetry,
  onRefresh,
  onAction,
  onOpenCase,
  navigation,
  read = nativeWorkbenchRead,
}: {
  page: WorkbenchRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
  onAction?: ReportQueueAction;
  onOpenCase?: (item: WorkbenchCase, href: string) => void;
  navigation?: {
    isCurrent: () => boolean;
    subscribe: (retire: () => void) => () => void;
    visitId?: string;
  };
  read?: WorkbenchReader;
}) {
  const client = useContext(QueryClientContext);
  const windowHistory = useMemo(() => (client ? workbenchQueueWindowHistory(client) : undefined), [client]);
  const windowRevision = useSyncExternalStore(
    windowHistory?.subscribe ?? (() => () => {}),
    windowHistory?.snapshot ?? (() => 0),
    () => 0,
  );
  const [replacement, setReplacement] = useState<{ original: WorkbenchRead; page: WorkbenchRead }>();
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const unresolved = useRef(false);
  const [refreshBlocked, setRefreshBlocked] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const recovery = useRef<{ cancel: () => void; focus: boolean } | null>(null);
  const data = replacement?.original === page ? replacement.page : page;
  const owner = useMemo(() => {
    if (typeof window === 'undefined' || !client) return undefined;
    return createPrivateReaderLifetime(client, page, workbenchReadKey(search), navigation);
  }, [client, page, search, navigation, read]);
  const version = useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.snapshot ?? (() => 0), () => 0);
  useEffect(() => () => owner?.retire(), [owner]);
  const locale = useRef(page.locale ?? getLocale());
  if (getLocale() !== locale.current) owner?.retire();
  const retired = Boolean(owner && (!owner.healthy() || (search.history && !owner.available()))) && version >= 0;
  const admitted = !owner || owner.available();
  const directorySource = useRef(data.directory?.state === 'ready' ? data.directory.source : null);
  const changedSource =
    data.directory?.state === 'ready' &&
    directorySource.current !== null &&
    data.directory.source !== directorySource.current;
  if (data.directory?.state === 'ready' && directorySource.current === null)
    directorySource.current = data.directory.source;
  useLayoutEffect(() => {
    if (retired) request.current?.abort();
    return () => request.current?.abort();
  }, [owner, retired]);
  useEffect(() => () => recovery.current?.cancel(), [owner]);
  const view = retired
    ? {
        ...data,
        search,
        state: 'denied' as const,
        cases: [],
        reports: [],
        appeals: [],
        selectedTarget: null,
        selectedAppeal: null,
        realms: [],
        boards: [],
        next: null,
        realmsNext: null,
        boardsNext: null,
        directory: undefined,
        history: undefined,
      }
    : {
        ...data,
        search,
        ...(data.directory && (!admitted || changedSource)
          ? {
              directory: {
                state: changedSource ? ('stale' as const) : ('preparing' as const),
                items: [] as [],
                next: null,
              },
            }
          : {}),
      };
  const isCurrent = () =>
    !retired && getLocale() === locale.current && (!owner || (owner.available() && owner.isCurrent()));
  const currentRef = useRef(isCurrent);
  currentRef.current = isCurrent;
  const identity = `${view.generation}:${view.readKey}:${search.queue}:${view.state}`;
  const generation = useRef<{ identity: string; controller: ReturnType<typeof createWorkbenchSelection> } | null>(null);
  if (!generation.current || generation.current.identity !== identity) {
    generation.current?.controller.retire();
    generation.current = {
      identity,
      controller: createWorkbenchSelection(view.reports ?? [], search, () => currentRef.current()),
    };
  }
  const controller = generation.current.controller;
  const windowVisitId = owner?.available() && isCurrent() ? navigation?.visitId : undefined;
  const windowFence = workbenchReaderFence(page, locale.current);
  const queueWindow = useMemo(
    () => (view.state === 'denied' ? undefined : windowHistory?.view(windowVisitId, search, view.state)),
    [windowHistory, windowRevision, windowVisitId, search, view.state],
  );
  // The child reports pending synchronously, before React renders another refresh control.
  function unresolvedChanged(value: boolean) {
    unresolved.current = value;
    setRefreshBlocked(value);
  }
  async function refresh() {
    if (
      !isCurrent() ||
      unresolved.current ||
      readingRef.current ||
      controller.unresolved() ||
      controller.needsDecision()
    )
      return;
    await onRefresh?.();
  }
  function navigateSearch(next: WorkbenchSearch) {
    if (!isCurrent()) return;
    if (windowHistory) {
      if (isWorkbenchHistoryTransition(search, next))
        windowHistory.beginHistory(navigation?.visitId, search, next);
      else windowHistory.clearForVisit(navigation?.visitId);
    }
    onSearch(next);
  }
  function windowMove(move: WorkbenchWindowMove, source?: HTMLButtonElement, keyboard = false) {
    if (!isCurrent() || !windowHistory || !navigation?.visitId || !windowFence) return;
    if (move === 'next' && (!page.next || page.next.length > 4096)) return;
    if (move === 'previous' && windowHistory.previousAddress(navigation.visitId, search) === undefined) return;
    if (
      !windowHistory.beginMove({
        visitId: navigation.visitId,
        search,
        fence: windowFence,
        move,
        source,
        keyboard,
      })
    )
      return;
    if (move === 'refresh') {
      void refresh();
      return;
    }
    if (move === 'first') {
      const first = workbenchWithoutContinuation(search);
      if (search.cursor) onSearch(first);
      else void refresh();
      return;
    }
    if (move === 'next') {
      onSearch(workbenchSearch({ ...search, cursor: page.next }));
      return;
    }
    const cursor = windowHistory.previousAddress(navigation.visitId, search);
    onSearch(workbenchSearch({ ...search, cursor: cursor ?? undefined }));
  }
  function retryWindow(source?: HTMLButtonElement, keyboard = false) {
    if (!isCurrent() || !windowHistory || !navigation?.visitId || !windowFence) return;
    if (
      !windowHistory.beginRetry({
        visitId: navigation.visitId,
        search,
        fence: windowFence,
        source,
        keyboard,
      })
    )
      return;
    onRetry?.();
  }
  function openCase(item: WorkbenchCase, href: string) {
    if (!isCurrent()) return;
    if (item.kind === 'report' && windowHistory && navigation?.visitId && windowFence)
      windowHistory.beginCaseDeparture({
        visitId: navigation.visitId,
        search,
        fence: windowFence,
        reportId: item.id,
      });
    onOpenCase?.(item, href);
  }
  async function retryInspection(event?: MouseEvent<HTMLButtonElement>) {
    if (!isCurrent() || unresolved.current || readingRef.current) return;
    recovery.current?.cancel();
    const control = event?.currentTarget;
    const handoff = {
      focus: event?.detail === 0 && document.activeElement === control,
      cancel() {
        handoff.focus = false;
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('focusin', focusin, true);
      },
    };
    const cancel = () => handoff.cancel();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    const focusin = (event: FocusEvent) => {
      if (event.target !== control && event.target !== document.body) cancel();
    };
    recovery.current = handoff;
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin, true);
    const ticket = owner?.ticket();
    const input = Object.freeze({ ...search });
    const controller = new AbortController();
    request.current = controller;
    const stopSession = client
      ? privateReaderSessionSource(client).subscribe(() => {
          if (!isCurrent()) controller.abort();
        })
      : () => {};
    const stopNavigation = navigation?.subscribe(() => controller.abort());
    readingRef.current = true;
    setReading(true);
    try {
      const next = await read(input, controller.signal);
      controller.signal.throwIfAborted();
      if (!isCurrent() || (owner && !owner.owns(ticket!))) return;
      if (
        next.readKey !== workbenchReadKey(input) ||
        (next.locale !== undefined && next.locale !== locale.current) ||
        (owner && !(await owner.accepts(next)))
      ) {
        owner?.retire();
        handoff.cancel();
        return;
      }
      controller.signal.throwIfAborted();
      if (isCurrent() && (!owner || owner.owns(ticket!))) setReplacement({ original: page, page: next });
    } catch {
      if (!controller.signal.aborted && isCurrent() && (!owner || owner.owns(ticket!)))
        setReplacement({
          original: page,
          page: {
            ...data,
            state: data.directory ? 'ready' : 'unavailable',
            directory: data.directory ? { state: 'unavailable', items: [], next: null } : undefined,
            cases: [],
            reports: [],
            appeals: [],
            selectedAppeal: null,
            selectedTarget: null,
            next: null,
            history: undefined,
          },
        });
    } finally {
      stopSession();
      stopNavigation?.();
      if (request.current === controller) request.current = null;
      readingRef.current = false;
      if (isCurrent()) setReading(false);
      else handoff.cancel();
    }
  }
  useLayoutEffect(() => {
    if (owner && (!owner.available() || !isCurrent())) {
      if (navigation?.isCurrent() !== false && !owner.healthy()) windowHistory?.clearForVisit(navigation?.visitId);
      return;
    }
    const focus = windowHistory?.admitQueue({
      visitId: navigation?.visitId,
      page: data,
      search,
      locale: locale.current,
      admitted: !owner || owner.available(),
    });
    if (focus) {
      const returnTarget =
        focus.kind === 'case-return' && focus.reportId
          ? document.getElementById(`workbench-case-${encodeURIComponent(focus.reportId)}`)
          : null;
      const queueHeading = boundary.current?.querySelector<HTMLElement>('[data-workbench-current-queue]');
      (returnTarget ?? queueHeading ?? boundary.current?.querySelector<HTMLElement>('article'))?.focus();
    }
    // A direct visit or pointer navigation has no focus ticket to restore.
  }, [owner, data, search, navigation?.visitId, version]);
  useLayoutEffect(() => {
    const handoff = recovery.current;
    if (!handoff || reading || !isCurrent()) return;
    const focus = handoff.focus;
    handoff.cancel();
    recovery.current = null;
    if (focus) {
      const target =
        boundary.current?.querySelector<HTMLButtonElement>('[data-workbench-retry]') ??
        (view.state === 'ready' ? boundary.current?.querySelector<HTMLElement>('article') : null);
      target?.focus();
    }
  }, [reading, view.generation, view.state]);
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  useEffect(
    () => () => {
      controller.retire();
    },
    [controller],
  );
  const submit: ReportQueueAction = async (command) => {
    if (!isCurrent()) return;
    if (owner && !owner.canCommand()) return { ok: false, state: 'forbidden' };
    return (onAction ?? nativeReportAction)(command);
  };
  return (
    <WorkbenchSelectionBoundary>
      <div ref={boundary} aria-busy={reading}>
        {reading ? <p role="status">{m.moderation_workbench_preparing()}</p> : null}
        {retired && page.directory && onRetry ? (
          <section className="space-y-3">
            <p role="status">{m.moderation_directory_retired()}</p>
            <Button
              className="min-h-11 whitespace-normal"
              onClick={() => {
                if (!navigation || navigation.isCurrent()) onRetry();
              }}
            >
              {m.moderation_directory_restart()}
            </Button>
          </section>
        ) : null}
        <WorkbenchView
          key={identity}
          page={view}
          onSearch={navigateSearch}
          onOpenCase={openCase}
          selection={controller}
          onAction={submit}
          isCurrent={isCurrent}
          {...(queueWindow ? { queueWindow } : {})}
          {...(windowHistory && windowVisitId ? { onWindowMove: windowMove } : {})}
          {...(queueWindow?.retry ? { retryWindow: queueWindow.retry, onRetryWindow: retryWindow } : {})}
          onUnresolvedAppealChange={unresolvedChanged}
          refreshBlocked={refreshBlocked}
          onRestart={() => onSearch(workbenchWithoutContinuation(search))}
          {...(!reading &&
          ((search.queue === 'appeals' && search.case) ||
            (view.directory && view.directory.state !== 'ready' && view.directory.state !== 'stale'))
            ? { onRetry: (event?: MouseEvent<HTMLButtonElement>) => void retryInspection(event) }
            : !reading && onRetry
              ? {
                  onRetry: () => {
                    if (!unresolved.current && isCurrent()) onRetry();
                  },
                }
              : {})}
          {...(onRefresh && !reading ? { onRefresh: refresh } : {})}
        />
      </div>
    </WorkbenchSelectionBoundary>
  );
}
