import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';
import { browserObservation } from '../../session/observation';

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

const noSubscription = () => () => {};
const noObservation = () => undefined;

/** Private in-memory import visit, retired when either viewer or CSRF custody changes. */
export function useVndbVisit(): VndbVisit | null {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : null;
  const observed = useSyncExternalStore(
    observation?.subscribe ?? noSubscription,
    observation?.getSnapshot ?? noObservation,
    observation?.getServerSnapshot ?? noObservation,
  );
  const session = client?.getQueryData<SessionValue>(sessionQuery.queryKey);
  const incarnation = observed?.state === 'signed-in' ? observed.observation.id : null;
  const owner = `${identity(session)}:${incarnation}`;
  const ready =
    observed?.state === 'signed-in' && session?.state === 'signed-in' && !!session.subject && !!session.csrfToken;
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
        const latest = observation?.getSnapshot();
        if (
          latest?.state !== 'signed-in' ||
          latest.observation.id !== incarnation ||
          latest.observation.subject !== subject ||
          identity(client?.getQueryData<SessionValue>(sessionQuery.queryKey)) !== identity(session)
        )
          state.retire();
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
    };
    return state;
  }, [client, csrfToken, owner, subject, observation, incarnation]);
}
