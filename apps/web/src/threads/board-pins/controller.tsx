import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Badge } from '@rezics/ui/shadcn/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import {
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { m } from '../../paraglide/messages.js';
import { browserObservation } from '../../session/observation';
import { sessionQuery } from '../../session/query';
import type { useSession } from '../../session/query';
import type { BoardPinAdviceSelection } from './advice';
import {
  BoardPinCommandCaller,
  joinBoardPinPage,
  type BoardPinAction,
  type BoardPinBoardRead,
  type BoardPinFeedState,
  type BoardPinProducer,
  type BoardPinRowStatus,
  type BoardPinSender,
  type BoardPinThread,
} from './contract';
import { productionBoardPinProducer } from './producer';

type SessionValue = ReturnType<typeof useSession>;

type SessionObservation = {
  id: number;
  read(): SessionValue | undefined;
  healthy(): boolean;
  snapshot(): number;
  serverSnapshot(): number;
  subscribe(listener: () => void): () => void;
};

let nextSessionObservationId = 0;
let nextProducerId = 0;
const producerIds = new WeakMap<object, number>();

function producerId(producer: BoardPinProducer): number {
  const existing = producerIds.get(producer);
  if (existing !== undefined) return existing;
  const id = ++nextProducerId;
  producerIds.set(producer, id);
  return id;
}

function observeSession(client: QueryClient | undefined): SessionObservation {
  const id = ++nextSessionObservationId;
  if (!client) {
    return {
      id,
      read: () => undefined,
      healthy: () => false,
      snapshot: () => 0,
      serverSnapshot: () => 0,
      subscribe: () => () => {},
    };
  }

  const shared = browserObservation(client);
  const state = () => shared.getSnapshot();
  const snapshot = () => {
    const current = state();
    return current.state === 'signed-in' ? current.observation.id : 0;
  };
  return {
    id,
    read() {
      const current = state();
      const value = client.getQueryData<SessionValue>(sessionQuery.queryKey);
      return current.state === 'signed-in' &&
        value?.state === 'signed-in' &&
        value.subject === current.observation.subject
        ? value
        : undefined;
    },
    healthy: () => state().state === 'signed-in',
    snapshot,
    serverSnapshot: () => 0,
    subscribe: (listener) => shared.subscribe(listener),
  };
}

function currentSender(observation: SessionObservation): BoardPinSender | null {
  const value = observation.read();
  if (
    !observation.healthy() ||
    value?.state !== 'signed-in' ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    typeof value.csrfToken !== 'string' ||
    value.csrfToken.length === 0
  )
    return null;
  return Object.freeze({ subject: value.subject, csrfToken: value.csrfToken });
}

export type BoardPinVisit = {
  key: string;
  observation: SessionObservation;
  revision: number;
  sender: BoardPinSender | null;
};

/** A cache replacement retires the page's private command recovery, including away/back transitions. */
export function useBoardPinVisit(senderOverride?: BoardPinSender): BoardPinVisit {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => observeSession(client), [client]);
  const revision = useSyncExternalStore(observation.subscribe, observation.snapshot, observation.serverSnapshot);
  const sender = senderOverride ?? currentSender(observation);
  return {
    observation,
    revision,
    sender,
    key: JSON.stringify([observation.id, revision, sender?.subject ?? null, sender?.csrfToken ?? null]),
  };
}

export function boardPinVisitKey(input: {
  boardId: string;
  sort?: 'active' | 'hot' | 'new';
  cursor?: string;
  producer: BoardPinProducer;
  visit: BoardPinVisit;
}): string {
  return JSON.stringify([
    input.visit.key,
    input.boardId,
    input.sort ?? null,
    input.cursor ?? null,
    producerId(input.producer),
  ]);
}

export type BoardPinPageController = {
  state: BoardPinFeedState;
  rowStatuses: Readonly<Record<string, BoardPinRowStatus | undefined>>;
  sender: BoardPinSender | null;
  needsRestart: boolean;
  malformed: boolean;
  refresh(): void;
  start(threadId: string, action: BoardPinAction): boolean;
  retry(threadId: string): boolean;
};

export function useBoardPinPage(input: {
  boardId: string;
  threadIds: readonly string[];
  sort?: 'active' | 'hot' | 'new';
  cursor?: string;
  adviceSelection?: BoardPinAdviceSelection;
  producer?: BoardPinProducer;
  visit: BoardPinVisit;
  onBoardRead?: (result: Extract<BoardPinBoardRead, { state: 'ready' }>) => BoardPinAdviceSelection | undefined;
}): BoardPinPageController {
  const producer = input.producer ?? productionBoardPinProducer;
  const threadKey = JSON.stringify(input.threadIds);
  const threadIds = useMemo(() => [...input.threadIds], [threadKey]);
  const snapshot = (): BoardPinFeedState => {
    if (threadIds.length === 0) return { state: 'empty' };
    return input.adviceSelection && producer.inspectSelected ? { state: 'preparing' } : { state: 'unavailable' };
  };
  const [state, setState] = useState<BoardPinFeedState>(snapshot);
  const [rowStatuses, setRowStatuses] = useState<Record<string, BoardPinRowStatus | undefined>>({});
  const [needsRestart, setNeedsRestart] = useState(false);
  const [malformed, setMalformed] = useState(false);
  const [adviceRefreshNonce, setAdviceRefreshNonce] = useState(0);
  const [freshSelection, setFreshSelection] = useState<{
    serial: number;
    selection?: BoardPinAdviceSelection;
  } | null>(null);
  const live = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const adviceController = useRef<AbortController | null>(null);
  const adviceGeneration = useRef(0);
  const busyRows = useRef(new Set<string>());
  const caller = useRef<BoardPinCommandCaller | null>(null);
  const desiredCommandScope = useRef('');
  const callerCommandScope = useRef('');
  const desiredAdviceKey = useRef('');
  const activeAdviceKey = useRef('');
  const restartAfterCommand = useRef(false);
  const refreshRef = useRef(async () => {});

  const keepRetry = (current: Record<string, BoardPinRowStatus | undefined>) =>
    Object.fromEntries(
      Object.entries(current).filter(([, status]) => status?.state === 'unknown' || status?.state === 'unavailable'),
    );

  const refresh = async () => {
    if (!isAdviceCurrent()) return;
    adviceController.current?.abort();
    adviceGeneration.current += 1;
    if (!producer.readBoard) {
      setState({ state: 'preparing' });
      setAdviceRefreshNonce((current) => current + 1);
      return;
    }
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setState({ state: 'preparing' });
    try {
      const omitCursor = restartAfterCommand.current || !input.cursor;
      const result = await producer.readBoard({
        boardId: input.boardId,
        ...(input.sort ? { sort: input.sort } : {}),
        ...(!omitCursor && input.cursor ? { cursor: input.cursor } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted || !isAdviceCurrent()) return;
      if (result.state === 'restart') {
        setNeedsRestart(true);
        setMalformed(false);
        setState({ state: 'stale' });
        return;
      }
      if (result.state === 'malformed') {
        setMalformed(true);
        setState({ state: 'unavailable' });
        return;
      }
      if (result.state !== 'ready' || result.boardId !== input.boardId) {
        setState(result.state === 'denied' ? result : { state: 'unavailable' });
        return;
      }
      restartAfterCommand.current = false;
      setNeedsRestart(false);
      setMalformed(false);
      const selection = input.onBoardRead?.(result);
      const serial = adviceRefreshNonce + 1;
      setFreshSelection({ serial, ...(selection ? { selection } : {}) });
      setAdviceRefreshNonce(serial);
    } catch {
      if (!controller.signal.aborted && isAdviceCurrent()) setState({ state: 'unavailable' });
    }
  };
  refreshRef.current = refresh;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      readController.current?.abort();
      readController.current = null;
      adviceController.current?.abort();
      adviceController.current = null;
      adviceGeneration.current += 1;
      caller.current?.retire();
    };
    // Each visit is mounted under the exact page/session key computed by BoardFeed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedForInspection =
    freshSelection?.serial === adviceRefreshNonce ? freshSelection.selection : input.adviceSelection;
  const adviceKey = JSON.stringify([
    input.boardId,
    input.visit.key,
    producerId(producer),
    selectedForInspection ?? null,
  ]);
  const commandScopeKey = JSON.stringify([
    input.boardId,
    input.visit.key,
    producerId(producer),
    selectedForInspection?.selected ?? null,
  ]);
  desiredAdviceKey.current = adviceKey;
  desiredCommandScope.current = commandScopeKey;
  if (!activeAdviceKey.current) activeAdviceKey.current = adviceKey;
  if (!callerCommandScope.current) callerCommandScope.current = commandScopeKey;
  const isCommandCurrent = () =>
    live.current &&
    input.visit.observation.snapshot() === input.visit.revision &&
    callerCommandScope.current === desiredCommandScope.current;
  const isAdviceCurrent = () => isCommandCurrent() && activeAdviceKey.current === desiredAdviceKey.current;
  const makeCaller = () =>
    new BoardPinCommandCaller(producer, isCommandCurrent, (threadId, status, result) => {
      if (!isCommandCurrent()) return;
      setRowStatuses((current) => ({ ...current, [threadId]: status }));
      if (result?.state !== 'applied' || result.boardId !== input.boardId) return;
      if (isAdviceCurrent())
        setState((current) => {
          if (current.state !== 'ready' || !current.byThreadId.has(threadId)) return current;
          const byThreadId = new Map(current.byThreadId);
          byThreadId.set(threadId, { ...result.thread, actions: [] });
          return { ...current, byThreadId };
        });
      if (!producer.readBoard) {
        if (isAdviceCurrent()) setState({ state: 'unavailable' });
        return;
      }
      if (input.cursor) {
        restartAfterCommand.current = true;
        setNeedsRestart(true);
        if (isAdviceCurrent()) setState({ state: 'stale' });
        return;
      }
      if (isAdviceCurrent()) setState({ state: 'preparing' });
      queueMicrotask(() => void refreshRef.current());
    });
  if (!caller.current) {
    caller.current = makeCaller();
  }
  useEffect(() => {
    if (activeAdviceKey.current === adviceKey && callerCommandScope.current === commandScopeKey) return;
    adviceController.current?.abort();
    readController.current?.abort();
    adviceGeneration.current += 1;
    if (callerCommandScope.current !== commandScopeKey) {
      caller.current?.retire();
      caller.current = makeCaller();
      callerCommandScope.current = commandScopeKey;
      busyRows.current.clear();
      setRowStatuses({});
    } else setRowStatuses(keepRetry);
    activeAdviceKey.current = adviceKey;
    setNeedsRestart(false);
    setMalformed(false);
    setState(snapshot());
    // Cohort identity owns command recovery; pin generation also invalidates advice and refresh work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adviceKey, commandScopeKey]);
  useEffect(() => {
    if (!live.current) return;
    adviceController.current?.abort();
    const controller = new AbortController();
    adviceController.current = controller;
    const generation = ++adviceGeneration.current;
    const selection = selectedForInspection;
    const sender = input.visit.sender;
    const inspectSelected = producer.inspectSelected;
    if (!selection || !sender || !inspectSelected) {
      if (isAdviceCurrent()) setState(threadIds.length === 0 ? { state: 'empty' } : { state: 'unavailable' });
      return () => controller.abort();
    }
    setState({ state: 'preparing' });
    void (async () => {
      try {
        const result = await inspectSelected({
          boardId: input.boardId,
          viewerId: sender.subject,
          selected: selection.selected,
          pinRevision: selection.pinRevision,
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== adviceGeneration.current || !isAdviceCurrent()) return;
        if (result.state === 'stale') {
          restartAfterCommand.current = true;
          setNeedsRestart(true);
          setState({ state: 'stale' });
          return;
        }
        if (result.state !== 'ready') {
          setState(result);
          return;
        }
        if (
          result.boardId !== input.boardId ||
          result.viewer.id !== sender.subject ||
          result.pinRevision !== selection.pinRevision
        ) {
          setState({ state: 'unavailable' });
          return;
        }
        const selectedIds = selection.selected.map((reference) => reference.threadId);
        const next = joinBoardPinPage(input.boardId, selectedIds, result);
        setState(next);
        if (next.state === 'ready') setRowStatuses(keepRetry);
      } catch {
        if (!controller.signal.aborted && generation === adviceGeneration.current && isAdviceCurrent())
          setState({ state: 'unavailable' });
      }
    })();
    return () => {
      controller.abort();
      if (adviceController.current === controller) adviceController.current = null;
    };
    // Selection values are represented by adviceKey; the visit key binds the observed credentials.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adviceKey, adviceRefreshNonce]);

  const start = (threadId: string, action: BoardPinAction) => {
    const sender = input.visit.sender;
    const row = state.state === 'ready' ? state.byThreadId.get(threadId) : undefined;
    if (
      !isAdviceCurrent() ||
      !sender ||
      state.state !== 'ready' ||
      state.management !== 'allowed' ||
      !row?.actions.includes(action) ||
      busyRows.current.has(threadId)
    )
      return false;
    busyRows.current.add(threadId);
    caller.current?.start({ boardId: input.boardId, threadId, action, sender });
    queueMicrotask(() => busyRows.current.delete(threadId));
    return true;
  };

  const retry = (threadId: string) => {
    const status = rowStatuses[threadId];
    if (!isCommandCurrent() || (status?.state !== 'unknown' && status?.state !== 'unavailable')) return false;
    caller.current?.retry(threadId);
    return true;
  };

  const matchesCurrentAdvice = activeAdviceKey.current === adviceKey && callerCommandScope.current === commandScopeKey;
  return {
    state: matchesCurrentAdvice ? state : { state: 'preparing' },
    rowStatuses: matchesCurrentAdvice ? rowStatuses : {},
    sender: input.visit.sender,
    needsRestart: matchesCurrentAdvice && needsRestart,
    malformed: matchesCurrentAdvice && malformed,
    refresh: () => void refresh(),
    start,
    retry,
  };
}

export function BoardPinPageStatus({ state, onRetry }: { state: BoardPinFeedState; onRetry(): void }): ReactNode {
  let message: string | null = null;
  if (state.state === 'preparing') message = m.board_pin_preparing();
  else if (state.state === 'denied') message = m.board_pin_read_denied();
  else if (state.state === 'unavailable') message = m.board_pin_unavailable();
  else if (state.state === 'ready' && state.management === 'denied') message = m.board_pin_read_only();
  else if (state.state === 'ready' && state.capacityFull) message = m.board_pin_full();
  if (!message) return null;
  return createElement(
    'div',
    { className: 'flex min-w-0 flex-wrap items-center gap-2', 'data-slot': 'board-pin-status' },
    createElement('p', { role: 'status', className: 'min-w-0 text-sm text-muted-foreground' }, message),
    state.state === 'preparing' || state.state === 'empty'
      ? null
      : createElement(
          Button,
          {
            type: 'button',
            variant: 'outline',
            className: 'min-h-11 min-w-11',
            onClick: onRetry,
          },
          m.board_community_retry(),
        ),
  );
}

export function BoardPinBadge({ pinned }: { pinned: boolean }): ReactNode {
  return pinned ? createElement(Badge, { variant: 'secondary' }, m.board_pin_badge()) : null;
}

export function BoardPinThreadControls({
  discussionTitle,
  row,
  management,
  sender,
  status,
  onChange,
  onRetry,
  onRefresh,
}: {
  discussionTitle: string;
  row?: BoardPinThread;
  management: 'allowed' | 'denied' | null;
  sender: BoardPinSender | null;
  status?: BoardPinRowStatus;
  onChange(action: BoardPinAction): void;
  onRetry(): void;
  onRefresh(): void;
}): ReactNode {
  const [pending, setPending] = useState<BoardPinAction | null>(null);
  const action: BoardPinAction | null = row ? (row.pinned ? 'unpin' : 'pin') : null;
  const actionable = Boolean(row && action && management === 'allowed' && sender && row.actions.includes(action));
  const blocked = status !== undefined && status.state !== 'applied';
  const confirmTitle = pending === 'unpin' ? m.board_pin_confirm_title_unpin() : m.board_pin_confirm_title_pin();
  const confirmBody =
    pending === 'unpin'
      ? m.board_pin_confirm_unpin({ title: discussionTitle })
      : m.board_pin_confirm_pin({ title: discussionTitle });
  const statusText = status
    ? status.state === 'submitting'
      ? m.board_pin_saving()
      : status.state === 'applied'
        ? status.action === 'pin'
          ? m.board_pin_pinned()
          : m.board_pin_unpinned()
        : status.state === 'denied'
          ? m.board_pin_action_denied()
          : status.state === 'conflict'
            ? m.board_pin_conflict()
            : status.state === 'unknown'
              ? m.board_pin_unknown()
              : m.board_pin_action_unavailable()
    : null;
  return createElement(
    'div',
    {
      className: 'flex min-w-0 max-w-full flex-wrap items-center gap-2',
      role: 'group',
      'aria-label': m.board_pin_controls({ title: discussionTitle }),
      'aria-busy': status?.state === 'submitting',
    },
    actionable && !blocked && action
      ? createElement(
          Button,
          {
            type: 'button',
            variant: 'outline',
            className: 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal',
            ...{ 'data-board-pin-focus': 'toggle' },
            'aria-haspopup': 'dialog',
            'aria-expanded': pending !== null,
            onClick: () => setPending(action),
          },
          action === 'pin' ? m.board_pin_pin() : m.board_pin_unpin(),
        )
      : null,
    createElement(
      AlertDialog,
      {
        open: pending !== null,
        onOpenChange: (open: boolean) => {
          if (!open) setPending(null);
        },
      },
      createElement(
        AlertDialogContent,
        { className: 'min-w-0 max-w-lg grid-cols-[minmax(0,1fr)] text-start' },
        createElement(
          AlertDialogHeader,
          { className: 'min-w-0 place-items-stretch text-start' },
          createElement(AlertDialogTitle, null, confirmTitle),
          createElement(AlertDialogDescription, null, confirmBody),
        ),
        createElement(
          AlertDialogFooter,
          { className: 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2' },
          createElement(
            AlertDialogCancel,
            { className: 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal' },
            m.board_pin_cancel(),
          ),
          createElement(
            AlertDialogAction,
            {
              className: 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal',
              onClick: () => {
                if (!pending) return;
                onChange(pending);
                setPending(null);
              },
            },
            m.board_pin_confirm(),
          ),
        ),
      ),
    ),
    statusText
      ? createElement('span', { role: 'status', className: 'text-sm text-muted-foreground' }, statusText)
      : null,
    status?.state === 'unknown' || status?.state === 'unavailable'
      ? createElement(
          Button,
          {
            type: 'button',
            variant: 'outline',
            className: 'min-h-11 min-w-11',
            ...{ 'data-board-pin-focus': 'retry' },
            onClick: onRetry,
          },
          m.editorial_retry(),
        )
      : status?.state === 'conflict' || status?.state === 'denied'
        ? createElement(
            Button,
            {
              type: 'button',
              variant: 'outline',
              className: 'min-h-11 min-w-11',
              ...{ 'data-board-pin-focus': 'refresh' },
              onClick: onRefresh,
            },
            m.board_pin_refresh(),
          )
        : null,
  );
}
