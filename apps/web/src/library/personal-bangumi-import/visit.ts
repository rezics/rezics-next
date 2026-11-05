import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { sessionQuery } from '../../session/query';
import { browserObservation } from '../../session/observation';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };

export type BangumiVisit = {
  subject: string;
  csrfToken: string;
  identity: number;
  locale: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};

function sessionIdentity(session: SessionValue | undefined): string {
  return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
}

const noSubscription = () => () => {};
const noObservation = () => undefined;
let nextIdentity = 0;

/** Private visit bound to the current signed-in viewer and CSRF. Replacement retires Bangumi state. */
export function useBangumiVisit(): BangumiVisit | null {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : null;
  const observed = useSyncExternalStore(
    observation?.subscribe ?? noSubscription,
    observation?.getSnapshot ?? noObservation,
    observation?.getServerSnapshot ?? noObservation,
  );
  const session = client?.getQueryData<SessionValue>(sessionQuery.queryKey);
  const sessionKey = sessionIdentity(session);
  const incarnation = observed?.state === 'signed-in' ? observed.observation.id : null;
  const locale = getLocale();
  const owner = `${sessionKey}:${incarnation}:${locale}`;
  const ready =
    observed?.state === 'signed-in' &&
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const subject = ready ? session?.subject : null;
  const csrfToken = ready ? session?.csrfToken : null;
  return useMemo(() => {
    if (!ready || !subject || !csrfToken) return null;
    const state: BangumiVisit & { retired: boolean; owner: string } = {
      identity: ++nextIdentity,
      controller: new AbortController(),
      retired: false,
      owner,
      subject,
      csrfToken,
      locale,
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
          sessionIdentity(client?.getQueryData<SessionValue>(sessionQuery.queryKey)) !== sessionKey ||
          getLocale() !== locale
        )
          state.retire();
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
    };
    return state;
  }, [client, csrfToken, incarnation, locale, observation, owner, ready, sessionKey, subject]);
}
