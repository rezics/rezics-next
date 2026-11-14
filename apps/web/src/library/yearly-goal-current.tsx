import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useReaderVisit } from '../reader/lifetime';
import { getLocale } from '../paraglide/runtime.js';
import { useLibraryApplication } from './application';
import { YearlyGoalPage, type YearlyGoalPageApi, type YearlyGoalReadResult } from './yearly-goal-page';
import { readPrivateYearlyGoal, type YearlyGoalReadRequest } from './yearly-goal-server';

export type YearlyGoalReader = (input: YearlyGoalReadRequest, signal: AbortSignal) => Promise<YearlyGoalReadResult>;
const readNative: YearlyGoalReader = (data, signal) => readPrivateYearlyGoal({ data, signal });

/** The existing observer owns session/exposure replacement; this visit owns only its aborts and payload. */
export function createYearlyGoalVisit(input: {
  year: number;
  viewer: string;
  current: () => boolean;
  read: YearlyGoalReader;
}) {
  let retired = false;
  const aborts = new Set<AbortController>();
  const retire = () => {
    retired = true;
    for (const abort of aborts) abort.abort();
    aborts.clear();
  };
  const current = () => {
    if (!input.current()) retire();
    return !retired;
  };
  const api: YearlyGoalPageApi = {
    current,
    async read(year) {
      if (year !== input.year || !current()) return { state: 'retired' };
      const abort = new AbortController();
      aborts.add(abort);
      try {
        const result = await input.read({ year, viewer: input.viewer }, abort.signal);
        return current() ? result : { state: 'retired' };
      } catch {
        return { state: current() ? 'unavailable' : 'retired' };
      } finally {
        aborts.delete(abort);
      }
    },
    write: async () => ({ state: 'unavailable' }),
  };
  return { api, current, retire };
}

export function CurrentYearlyGoal({ year }: { year: number | undefined }) {
  const client = useQueryClient();
  const application = useLibraryApplication();
  const session = application.useSession();
  const observer = useMemo(() => application.recoveryObservation(client), [application, client]);
  const server = useMemo(() => ({ subject: null, csrfToken: null, identity: {} }), []);
  const observation = useSyncExternalStore(observer.subscribe, observer.read, () => server);
  const locale = getLocale();
  const address = useReaderVisit(`yearly-goal:${year ?? 'invalid'}`, locale, getLocale);
  const visit = useMemo(() => {
    if (year === undefined || !observation.subject || session.state !== 'signed-in') return undefined;
    return createYearlyGoalVisit({
      year,
      viewer: observation.subject,
      read: readNative,
      current: () => address.current() && observer.read().identity === observation.identity,
    });
  }, [year, observation, session.state, observer, address]);
  const previous = useRef(visit);
  if (previous.current !== visit) previous.current?.retire();
  previous.current = visit;
  useEffect(() => {
    if (!visit) return;
    const stop = observer.subscribe(() => visit.current());
    const stopAddress = address.subscribe(() => visit.current());
    return () => {
      stop();
      stopAddress();
      visit.retire();
    };
  }, [visit, observer, address]);
  return (
    <YearlyGoalPage
      year={year}
      sessionState={session.state}
      viewerSubject={observation.subject}
      api={visit?.api}
    />
  );
}
