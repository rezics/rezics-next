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
import { QueryClientContext } from '@tanstack/react-query';
import { csrfHeaders } from '../../threads/composer';
import { actionOnReport } from '../actions';
import { createPrivateReaderLifetime } from '../private-reader-lifetime';
import type { ReportQueueAction } from '../reports-view-action';
import { createWorkbenchSelection, WorkbenchSelectionBoundary } from '../workbench-selection';
import { workbenchReadKey, workbenchWithoutContinuation, type WorkbenchSearch } from './scope';
import { loadWorkbench, type WorkbenchRead } from './read';
import { WorkbenchView } from './view';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

export function WorkbenchPage({
  page,
  search,
  onSearch,
  onRetry,
  onRefresh,
  onAction,
  navigation,
  read = (search) => loadWorkbench({ data: search }),
}: {
  page: WorkbenchRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
  onAction?: ReportQueueAction;
  navigation?: { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
  read?: (search: WorkbenchSearch) => Promise<WorkbenchRead>;
}) {
  const client = useContext(QueryClientContext);
  const [replacement, setReplacement] = useState<{ original: WorkbenchRead; page: WorkbenchRead }>();
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const unresolved = useRef(false);
  const [refreshBlocked, setRefreshBlocked] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const recovery = useRef<{ cancel: () => void; focus: boolean } | null>(null);
  const data = replacement?.original === page ? replacement.page : page;
  const owner = useMemo(() => {
    if (typeof window === 'undefined' || !client) return undefined;
    return createPrivateReaderLifetime(client, page, workbenchReadKey(search), navigation);
  }, [client, page, search, navigation]);
  const version = useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.snapshot ?? (() => 0), () => 0);
  useEffect(() => () => owner?.retire(), [owner]);
  const retired = Boolean(owner && !owner.healthy()) && version >= 0;
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
      }
    : { ...data, search };
  const isCurrent = () => !retired && (!owner || owner.isCurrent());
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
    const input = { ...search };
    readingRef.current = true;
    setReading(true);
    try {
      const next = await read(input);
      if (!isCurrent() || (owner && !owner.owns(ticket!))) return;
      if (next.readKey !== workbenchReadKey(input) || (owner && !(await owner.accepts(next)))) {
        owner?.retire();
        handoff.cancel();
        return;
      }
      if (isCurrent() && (!owner || owner.owns(ticket!))) setReplacement({ original: page, page: next });
    } catch {
      if (isCurrent() && (!owner || owner.owns(ticket!)))
        setReplacement({
          original: page,
          page: {
            ...data,
            state: 'unavailable',
            cases: [],
            reports: [],
            appeals: [],
            selectedAppeal: null,
            selectedTarget: null,
            next: null,
          },
        });
    } finally {
      readingRef.current = false;
      if (isCurrent()) setReading(false);
      else handoff.cancel();
    }
  }
  useLayoutEffect(() => {
    const handoff = recovery.current;
    if (!handoff || reading || !isCurrent()) return;
    const focus = handoff.focus;
    handoff.cancel();
    recovery.current = null;
    if (focus) {
      const target =
        view.state === 'unavailable'
          ? boundary.current?.querySelector<HTMLButtonElement>('[data-workbench-retry]')
          : boundary.current?.querySelector<HTMLElement>('article');
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
        <WorkbenchView
          key={identity}
          page={view}
          onSearch={onSearch}
          selection={controller}
          onAction={submit}
          isCurrent={isCurrent}
          onUnresolvedAppealChange={unresolvedChanged}
          refreshBlocked={refreshBlocked || reading}
          onRestart={() => onSearch(workbenchWithoutContinuation(search))}
          {...(!reading && search.queue === 'appeals' && search.case
            ? { onRetry: (event?: MouseEvent<HTMLButtonElement>) => void retryInspection(event) }
            : !reading && onRetry
              ? {
                  onRetry: () => {
                    if (!unresolved.current && isCurrent()) onRetry();
                  },
                }
              : {})}
          {...(onRefresh ? { onRefresh: refresh } : {})}
        />
      </div>
    </WorkbenchSelectionBoundary>
  );
}
