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
import { workbenchReadKey, workbenchWithoutContinuation, type WorkbenchSearch } from './scope';
import { loadWorkbench, type WorkbenchRead, type WorkbenchReader } from './read';
import { WorkbenchView } from './view';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

const nativeWorkbenchRead: WorkbenchReader = (search, signal) => loadWorkbench({ data: search, signal });

export function WorkbenchPage({
  page,
  search,
  onSearch,
  onRetry,
  onRefresh,
  onAction,
  navigation,
  read = nativeWorkbenchRead,
}: {
  page: WorkbenchRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
  onAction?: ReportQueueAction;
  navigation?: { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
  read?: WorkbenchReader;
}) {
  const client = useContext(QueryClientContext);
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
  // The child reports pending synchronously, before React renders another refresh control.
  function unresolvedChanged(value: boolean) {
    unresolved.current = value;
    setRefreshBlocked(value);
  }
  async function refresh() {
    if (!isCurrent() || unresolved.current || readingRef.current) return;
    await onRefresh?.();
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
            state: 'unavailable',
            directory: undefined,
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
    if (isCurrent() && (document.activeElement === document.body || !document.activeElement?.isConnected))
      boundary.current?.querySelector<HTMLElement>('article')?.focus();
  }, [owner]);
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
          onSearch={(next) => {
            if (isCurrent()) onSearch(next);
          }}
          selection={controller}
          onAction={submit}
          isCurrent={isCurrent}
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
