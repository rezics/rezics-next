import { QueryClientContext, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { sessionQuery } from '../../session/query';
import { browserObservation } from '../../session/observation';
import { useReaderAddress } from '../../reader/current-origin';
import { getLocale } from '../../paraglide/runtime.js';
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
      headers: { 'X-CSRF-Token': input.csrfToken },
    });
  },
};

export function useSlowModePort(): SlowModePort {
  return useContext(SlowModePortContext) ?? productionPort;
}

export type SlowModeVisit = {
  id: string;
  boardId: string;
  subject: string;
  csrfToken: string;
  credentialMode: string;
  scopeKey: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};

let nextVisitId = 0;
const closedObservation = { state: 'unknown' } as const;
const emptySubscribe = () => () => {};
const emptySnapshot = () => closedObservation;

/** Private visit bound to its source, selection, credential mode, viewer and CSRF. */
export function useSlowModeVisit(
  boardId: string | undefined,
  scopeKey = 'board',
  credentialMode = 'session',
): SlowModeVisit | null {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : undefined;
  const owner = useSyncExternalStore(
    observation?.subscribe ?? emptySubscribe,
    observation?.getSnapshot ?? emptySnapshot,
    observation?.getServerSnapshot ?? emptySnapshot,
  );
  const session = client?.getQueryData<SessionValue>(sessionQuery.queryKey);
  const address = useReaderAddress(null, undefined, getLocale());
  const ready =
    !!boardId &&
    owner.state === 'signed-in' &&
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const visit = useMemo(() => {
    if (!ready || !boardId || !session?.subject || !session.csrfToken) return null;
    const state: SlowModeVisit & { retired: boolean } = {
      id: String(++nextVisitId),
      controller: new AbortController(),
      retired: false,
      boardId,
      subject: session.subject,
      csrfToken: session.csrfToken,
      credentialMode,
      scopeKey,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal = state.controller.signal) {
        if (observation?.getSnapshot() !== owner || !address.isCurrent()) state.retire();
        return !state.retired && !signal.aborted && signal === state.controller.signal;
      },
    };
    return state;
  }, [boardId, client, credentialMode, owner, ready, scopeKey, session?.csrfToken, session?.subject, address.key]);
  // Render replacement retires the previous owner before any retained callback can dispatch.
  const previous = useRef(visit);
  if (previous.current !== visit) previous.current?.retire();
  previous.current = visit;
  useLayoutEffect(() => {
    if (!visit) return;
    if (!visit.retired && visit.controller.signal.aborted) visit.controller = new AbortController();
    const stop = observation?.subscribe(() => visit.current());
    return () => {
      stop?.();
      visit.retire();
    };
  }, [visit, observation]);
  if (!visit?.current()) return null;
  return visit;
}

export function slowModeQueryKey(visit: SlowModeVisit) {
  return [
    'board-slow-mode',
    visit.id,
    visit.scopeKey,
    visit.credentialMode,
    visit.boardId,
    visit.subject,
    visit.csrfToken,
  ] as const;
}

export function useSlowModeRead(
  boardId: string | undefined,
  scopeKey = 'board',
  credentialMode = 'session',
): {
  visit: SlowModeVisit | null;
  read: SlowModeRead | undefined;
  preparing: boolean;
  reload: () => void;
} {
  const port = useSlowModePort();
  const visit = useSlowModeVisit(boardId, scopeKey, credentialMode);
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

export function rememberSlowModeRead(
  client: ReturnType<typeof useQueryClient>,
  visit: SlowModeVisit,
  read: SlowModeRead,
) {
  client.setQueryData(slowModeQueryKey(visit), read);
}
