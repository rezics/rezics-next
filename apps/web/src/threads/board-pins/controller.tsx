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
import { sessionQuery } from '../../session/query';
import type { useSession } from '../../session/query';
import {
  BoardPinCommandCaller,
  joinBoardPinPage,
  pinReadFromMembership,
  pinnedIdentitySet,
  type BoardPinAction,
  type BoardPinBoardRead,
  type BoardPinCommandInput,
  type BoardPinFeedState,
  type BoardPinProducer,
  type BoardPinReadResult,
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

  const read = () => client.getQueryData<SessionValue>(sessionQuery.queryKey);
  const queryState = () => client.getQueryState(sessionQuery.queryKey);
  const identity = () =>
    JSON.stringify([
      queryState()?.status ?? 'missing',
      read()?.state,
      read()?.subject ?? null,
      read()?.csrfToken ?? null,
    ]);
  let previous = identity();
  let revision = 0;
  const snapshot = () => {
    const next = identity();
    if (next !== previous) {
      previous = next;
      revision++;
    }
    return revision;
  };
  return {
    id,
    read,
    healthy: () => queryState()?.status === 'success',
    snapshot,
    serverSnapshot: () => 0,
    subscribe(listener) {
      return client.getQueryCache().subscribe((event) => {
        if (
          event.query.queryKey.length !== sessionQuery.queryKey.length ||
          event.query.queryKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
        )
          return;
        if (
          event.type !== 'removed' &&
          !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
        )
          return;
        const next = identity();
        if (next === previous && !(event.type === 'updated' && event.action.type === 'success')) return;
        previous = next;
        revision++;
        listener();
      });
    },
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
  initial?: BoardPinReadResult;
  producer: BoardPinProducer;
  visit: BoardPinVisit;
}): string {
  return JSON.stringify([
    input.visit.key,
    input.boardId,
    input.sort ?? null,
    input.cursor ?? null,
    input.initial ?? null,
    producerId(input.producer),
  ]);
}

export type BoardPinPageController = {
  state: BoardPinFeedState;
  rowStatuses: Readonly<Record<string, BoardPinRowStatus | undefined>>;
  sender: BoardPinSender | null;
  refresh(): void;
  start(threadId: string, action: BoardPinAction): void;
  retry(threadId: string): void;
};

export function useBoardPinPage(input: {
  boardId: string;
  threadIds: readonly string[];
  pinnedIds?: ReadonlySet<string>;
  sort?: 'active' | 'hot' | 'new';
  cursor?: string;
  initial?: BoardPinReadResult;
  producer?: BoardPinProducer;
  visit: BoardPinVisit;
  onBoardRead?: (result: Extract<BoardPinBoardRead, { state: 'ready' }>) => void;
}): BoardPinPageController {
  const producer = input.producer ?? productionBoardPinProducer;
  const threadKey = JSON.stringify(input.threadIds);
  const threadIds = useMemo(() => [...input.threadIds], [threadKey]);
  const snapshot = (): BoardPinFeedState => {
    if (input.initial) return joinBoardPinPage(input.boardId, threadIds, input.initial);
    if (threadIds.length === 0) return { state: 'empty' };
    return joinBoardPinPage(
      input.boardId,
      threadIds,
      pinReadFromMembership(input.boardId, threadIds, input.pinnedIds ?? new Set(), 'denied'),
    );
  };
  const [state, setState] = useState<BoardPinFeedState>(snapshot);
  const [rowStatuses, setRowStatuses] = useState<Record<string, BoardPinRowStatus | undefined>>({});
  const live = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const busyRows = useRef(new Set<string>());
  const caller = useRef<BoardPinCommandCaller | null>(null);
  const refreshRef = useRef(async () => {});

  const isCurrent = () => live.current && input.visit.observation.snapshot() === input.visit.revision;
  if (!caller.current) {
    caller.current = new BoardPinCommandCaller(producer, isCurrent, (threadId, status, result) => {
      setRowStatuses((current) => ({ ...current, [threadId]: status }));
      if (result?.state !== 'applied' || result.boardId !== input.boardId) return;
      setState((current) => {
        if (current.state !== 'ready' || !current.byThreadId.has(threadId)) return current;
        const byThreadId = new Map(current.byThreadId);
        byThreadId.set(threadId, result.thread);
        return { ...current, byThreadId };
      });
      if (producer.readBoard) queueMicrotask(() => void refreshRef.current());
    });
  }

  const keepRetry = (current: Record<string, BoardPinRowStatus | undefined>) =>
    Object.fromEntries(
      Object.entries(current).filter(([, status]) => status?.state === 'unknown' || status?.state === 'unavailable'),
    );

  const refresh = async () => {
    if (!isCurrent()) return;
    if (!producer.readBoard && threadIds.length === 0) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setState({ state: 'preparing' });
    try {
      if (producer.readBoard) {
        const result = await producer.readBoard({
          boardId: input.boardId,
          ...(input.sort ? { sort: input.sort } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          signal: controller.signal,
        });
        if (controller.signal.aborted || !isCurrent()) return;
        if (result.state !== 'ready') {
          setState(result);
          return;
        }
        input.onBoardRead?.(result);
        const ids = [
          ...[...pinnedIdentitySet(result.pinnedThreads)],
          ...result.threads.flatMap((row) =>
            row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : [],
          ),
        ].filter((id, index, all) => all.indexOf(id) === index);
        const next = joinBoardPinPage(
          input.boardId,
          ids,
          pinReadFromMembership(
            result.boardId,
            ids,
            pinnedIdentitySet(result.pinnedThreads),
            result.management,
            result.management === 'allowed' ? (_id, pinned) => (pinned ? ['unpin'] : ['pin']) : () => [],
          ),
        );
        setState(next);
        if (next.state === 'ready') setRowStatuses(keepRetry);
        return;
      }
      const result = await producer.readPage({
        boardId: input.boardId,
        threadIds: Object.freeze([...threadIds]),
        signal: controller.signal,
      });
      if (controller.signal.aborted || !isCurrent()) return;
      const next = joinBoardPinPage(input.boardId, threadIds, result);
      setState(next);
      if (next.state === 'ready') setRowStatuses(keepRetry);
    } catch {
      if (!controller.signal.aborted && isCurrent()) setState({ state: 'unavailable' });
    }
  };
  refreshRef.current = refresh;

  useEffect(() => {
    live.current = true;
    setState(snapshot());
    return () => {
      live.current = false;
      readController.current?.abort();
      readController.current = null;
      caller.current?.retire();
    };
    // Each visit is mounted under the exact page/session key computed by BoardFeed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (threadId: string, action: BoardPinAction) => {
    const sender = input.visit.sender;
    const row = state.state === 'ready' ? state.byThreadId.get(threadId) : undefined;
    if (
      !isCurrent() ||
      !sender ||
      state.state !== 'ready' ||
      state.management !== 'allowed' ||
      !row?.actions.includes(action) ||
      busyRows.current.has(threadId)
    )
      return;
    busyRows.current.add(threadId);
    caller.current?.start({ boardId: input.boardId, threadId, action, sender });
    queueMicrotask(() => busyRows.current.delete(threadId));
  };

  const retry = (threadId: string) => {
    if (!isCurrent()) return;
    caller.current?.retry(threadId);
  };

  return { state, rowStatuses, sender: input.visit.sender, refresh: () => void refresh(), start, retry };
}

export function BoardPinPageStatus({ state, onRetry }: { state: BoardPinFeedState; onRetry(): void }): ReactNode {
  let message: string | null = null;
  if (state.state === 'preparing') message = m.board_pin_preparing();
  else if (state.state === 'denied') message = m.board_pin_read_denied();
  else if (state.state === 'unavailable') message = m.board_pin_unavailable();
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
      pending
        ? createElement(
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
          )
        : null,
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
              onClick: onRefresh,
            },
            m.board_pin_refresh(),
          )
        : null,
  );
}
