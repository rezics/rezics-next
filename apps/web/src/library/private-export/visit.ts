import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };

export type ExportVisit = {
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

/** Private visit bound to the current signed-in viewer and CSRF. Replacement retires export bytes. */
export function useExportVisit(): ExportVisit | null {
  const session = useSessionValue();
  const owner = sessionIdentity(session);
  const ready =
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const subject = ready ? session?.subject : null;
  const csrfToken = ready ? session?.csrfToken : null;
  return useMemo(() => {
    if (!ready || !subject || !csrfToken) return null;
    const state: ExportVisit & { retired: boolean; owner: string } = {
      controller: new AbortController(),
      retired: false,
      owner,
      subject,
      csrfToken,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal) {
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
    };
    return state;
  }, [csrfToken, owner, ready, subject]);
}
