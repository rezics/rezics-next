import { QueryClientContext } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';
import { sameCommand, type MalCommand, type MalDeliveryCustody } from './contract';

type SessionValue = { state?: string; subject?: string | null; csrfToken?: string | null };

export type MalVisit = {
  subject: string;
  csrfToken: string;
  locale: string;
  controller: AbortController;
  current: (signal?: AbortSignal) => boolean;
  retire: () => void;
  delivery: () => MalDeliveryCustody | null;
  retainDelivery: (custody: MalDeliveryCustody) => void;
  resolveDelivery: (command: MalCommand) => void;
};

// Keep only one immutable uncertain command per sender in memory; never retain historical pages or write it to storage.
const uncertainDeliveries = new Map<string, MalDeliveryCustody>();

function custodyKey(subject: string): string {
  return subject;
}

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

/** Private visit bound to the current signed-in viewer and CSRF. Replacement retires rendered MAL state. */
export function useMalVisit(): MalVisit | null {
  const session = useSessionValue();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const locale = pathname.split('/').filter(Boolean)[0] ?? '';
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
    const key = custodyKey(subject);
    const state: MalVisit & { retired: boolean; owner: string } = {
      controller: new AbortController(),
      retired: false,
      owner: JSON.stringify([owner, locale]),
      subject,
      csrfToken,
      locale,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal) {
        return !state.retired && !state.controller.signal.aborted && signal?.aborted !== true;
      },
      delivery() {
        const custody = uncertainDeliveries.get(key);
        return custody ? structuredClone(custody) : null;
      },
      retainDelivery(custody) {
        uncertainDeliveries.set(key, structuredClone(custody));
      },
      resolveDelivery(command) {
        const custody = uncertainDeliveries.get(key);
        if (custody && sameCommand(custody.command, command)) uncertainDeliveries.delete(key);
      },
    };
    return state;
  }, [csrfToken, locale, owner, ready, subject]);
}
