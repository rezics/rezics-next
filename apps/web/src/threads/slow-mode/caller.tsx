import { QueryClientContext, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { sessionCsrfToken, sessionQuery } from '../../session/query';
import type { SlowModePort, SlowModeRead } from './contract';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };

export const SlowModePortContext = createContext<SlowModePort | null>(null);

export function SlowModePortProvider({ port, children }: { port: SlowModePort; children: ReactNode }) {
  return <SlowModePortContext.Provider value={port}>{children}</SlowModePortContext.Provider>;
}

const productionPort: SlowModePort = {
  async read(input) {
    const { readBoardSlowMode } = await import('./server');
    return readBoardSlowMode({ data: { boardId: input.boardId } });
  },
  async change(input) {
    const { changeBoardSlowMode } = await import('./server');
    return changeBoardSlowMode({
      data: {
        boardId: input.boardId,
        intervalSeconds: input.intervalSeconds,
        idempotencyKey: input.idempotencyKey,
      },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
  },
};

export function useSlowModePort(): SlowModePort {
  return useContext(SlowModePortContext) ?? productionPort;
}

export type SlowModeVisit = {
  boardId: string;
  subject: string;
  csrfToken: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};

function sessionIdentity(session: SessionValue | undefined): string {
  return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
}

function useSessionValue(): SessionValue | undefined {
  const client = useContext(QueryClientContext);
  return useSyncExternalStore(
    (notify) => client?.getQueryCache().subscribe(() => notify()) ?? (() => {}),
    () => client?.getQueryData<SessionValue>(sessionQuery.queryKey),
    () => undefined,
  );
}

/** Private visit bound to board, viewer and CSRF. Replacement retires mounted work. */
export function useSlowModeVisit(boardId: string | undefined): SlowModeVisit | null {
  const client = useContext(QueryClientContext);
  const session = useSessionValue();
  const owner = sessionIdentity(session);
  const ready =
    !!boardId &&
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const visit = useMemo(() => {
    if (!ready || !boardId || !session?.subject || !session.csrfToken) return null;
    const state: SlowModeVisit & { retired: boolean; owner: string } = {
      controller: new AbortController(),
      retired: false,
      owner,
      boardId,
      subject: session.subject,
      csrfToken: session.csrfToken,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal = state.controller.signal) {
        const live = client?.getQueryData<SessionValue>(sessionQuery.queryKey);
        if (sessionIdentity(live) !== state.owner) state.retire();
        return !state.retired && !signal.aborted && signal === state.controller.signal;
      },
    };
    return state;
  }, [boardId, client, owner, ready, session?.csrfToken, session?.subject]);
  useLayoutEffect(() => {
    if (!visit) return;
    if (!visit.retired && visit.controller.signal.aborted) visit.controller = new AbortController();
    return () => visit.retire();
  }, [visit]);
  if (!visit?.current()) return null;
  return visit;
}

export function slowModeQueryKey(visit: SlowModeVisit) {
  return ['board-slow-mode', visit.boardId, visit.subject, visit.csrfToken] as const;
}

export function useSlowModeRead(boardId: string | undefined): {
  visit: SlowModeVisit | null;
  read: SlowModeRead | undefined;
  preparing: boolean;
  reload: () => void;
} {
  const port = useSlowModePort();
  const visit = useSlowModeVisit(boardId);
  const query = useQuery({
    staleTime: 0,
    enabled: !!visit,
    queryKey: visit ? slowModeQueryKey(visit) : ['board-slow-mode', 'closed'],
    queryFn: async ({ signal }) => {
      if (!visit) return { kind: 'unavailable' as const };
      const owner = visit.controller.signal;
      if (!visit.current(owner) || signal.aborted) return { kind: 'unavailable' as const };
      const result = await port.read({
        boardId: visit.boardId,
        signal: AbortSignal.any([signal, owner]),
      });
      if (!visit.current(owner) || signal.aborted) return { kind: 'unavailable' as const };
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  });
  return {
    visit,
    read: visit && query.isSuccess ? query.data : visit && query.isError ? { kind: 'unavailable' } : undefined,
    preparing: !!visit && (query.isPending || query.isFetching),
    reload: () => {
      if (visit?.current()) void query.refetch();
    },
  };
}

export function rememberSlowModeRead(client: ReturnType<typeof useQueryClient>, visit: SlowModeVisit, read: SlowModeRead) {
  client.setQueryData(slowModeQueryKey(visit), read);
}
