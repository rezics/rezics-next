import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };

export type RecoveryVisit = {
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

/** A private recovery visit ends on viewer, credential epoch, route or component replacement. */
export function useRecoveryVisit(): RecoveryVisit | null {
  const session = useSessionValue();
  const owner = identity(session);
  const signedIn =
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const subject = signedIn ? session.subject : null;
  const csrfToken = signedIn ? session.csrfToken : null;
  return useMemo(() => {
    if (!signedIn || !subject || !csrfToken) return null;
    const state: RecoveryVisit & { retired: boolean; owner: string } = {
      controller: new AbortController(),
      retired: false,
      owner,
      subject,
      csrfToken,
      retire() {
        if (state.retired) return;
        state.retired = true;
        state.controller.abort();
      },
      current(signal) {
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
    };
    return state;
  }, [csrfToken, owner, signedIn, subject]);
}
