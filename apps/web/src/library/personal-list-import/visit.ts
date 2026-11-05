import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { browserObservation, sessionQuery } from '../../session';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };
export type VndbVisit = {
  subject: string;
  csrfToken: string;
  identity?: number;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
};
export type PersonalImportVisit = VndbVisit & { identity: number; locale: string };

function identity(session: SessionValue | undefined): string {
  return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
}

const noSubscription = () => () => {};
const noObservation = () => undefined;
let nextIdentity = 0;

/** Source evidence and callbacks belong to one browser observation, credential and locale. */
export function usePersonalImportVisit(): PersonalImportVisit | null {
  const client = useContext(QueryClientContext);
  const observation = client ? browserObservation(client) : null;
  const observed = useSyncExternalStore(
    observation?.subscribe ?? noSubscription,
    observation?.getSnapshot ?? noObservation,
    observation?.getServerSnapshot ?? noObservation,
  );
  const session = client?.getQueryData<SessionValue>(sessionQuery.queryKey);
  const sessionKey = identity(session);
  const incarnation = observed?.state === 'signed-in' ? observed.observation.id : null;
  const locale = getLocale();
  const ready =
    observed?.state === 'signed-in' && session?.state === 'signed-in' && !!session.subject && !!session.csrfToken;
  const subject = ready ? session.subject! : null;
  const csrfToken = ready ? session.csrfToken! : null;
  return useMemo(() => {
    if (!subject || !csrfToken) return null;
    const controller = new AbortController();
    const retire = () => controller.abort();
    return {
      identity: ++nextIdentity,
      subject,
      csrfToken,
      locale,
      controller,
      retire,
      current(signal?: AbortSignal) {
        const latest = observation?.getSnapshot();
        if (
          latest?.state !== 'signed-in' ||
          latest.observation.id !== incarnation ||
          latest.observation.subject !== subject ||
          identity(client?.getQueryData<SessionValue>(sessionQuery.queryKey)) !== sessionKey ||
          getLocale() !== locale
        )
          retire();
        return !controller.signal.aborted && signal?.aborted !== true;
      },
    };
  }, [client, csrfToken, subject, observation, incarnation, locale, sessionKey]);
}

export const useVndbVisit = usePersonalImportVisit;
