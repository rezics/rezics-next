import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };
export type VndbVisit = {
  subject: string;
  csrfToken: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};

function identity(session: SessionValue | undefined): string {
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

/** Private in-memory import visit, retired when either viewer or CSRF custody changes. */
export function useVndbVisit(): VndbVisit | null {
  const session = useSessionValue();
  const owner = identity(session);
  const ready = session?.state === 'signed-in' && !!session.subject && !!session.csrfToken;
  const subject = ready ? session.subject! : null;
  const csrfToken = ready ? session.csrfToken! : null;
  return useMemo(() => {
    if (!subject || !csrfToken) return null;
    const state: VndbVisit & { retired: boolean; owner: string } = {
      subject,
      csrfToken,
      controller: new AbortController(),
      retired: false,
      owner,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal) {
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
    };
    return state;
  }, [csrfToken, owner, subject]);
}
