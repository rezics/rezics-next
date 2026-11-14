import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useReaderVisit } from '../session';
import type { ExpectedReader } from '../session/expected-reader';
import { getLocale } from '../paraglide/runtime.js';
import { useLibraryApplication } from './application';
import {
  YearlyGoalPage,
  type YearlyGoalCommand,
  type YearlyGoalPageApi,
  type YearlyGoalReadResult,
  type YearlyGoalWriteResult,
} from './yearly-goal-page';
import type { YearlyGoalDispatch, YearlyGoalPreparation, YearlyGoalReadRequest } from './yearly-goal-server';

export type YearlyGoalReader = (input: YearlyGoalReadRequest, signal: AbortSignal) => Promise<YearlyGoalReadResult>;
export type YearlyGoalSender = {
  prepare: (reader: ExpectedReader, signal: AbortSignal) => Promise<YearlyGoalPreparation>;
  write: (call: YearlyGoalDispatch, signal: AbortSignal) => Promise<YearlyGoalWriteResult>;
};
const readNative: YearlyGoalReader = async (data, signal) => {
  const { readPrivateYearlyGoal } = await import('./yearly-goal-server');
  return readPrivateYearlyGoal({ data, signal });
};
const nativeSender: YearlyGoalSender = {
  async prepare(data, signal) {
    const { preparePrivateYearlyGoal } = await import('./yearly-goal-server');
    return preparePrivateYearlyGoal({ data, signal, headers: { 'x-csrf-token': data.expectedCredential } });
  },
  async write(data, signal) {
    const { writePrivateYearlyGoal } = await import('./yearly-goal-server');
    return writePrivateYearlyGoal({ data, signal, headers: { 'x-csrf-token': data.expectedCredential } });
  },
};

type OriginalIntent = {
  source: YearlyGoalCommand;
  command: YearlyGoalCommand;
  reader: ExpectedReader;
  sender: YearlyGoalSender;
  credential?: string;
};

/** The existing observer owns session/exposure replacement; this visit owns only its aborts and native intent. */
export function createYearlyGoalVisit(input: {
  year: number;
  viewer: string;
  csrfToken: string | null;
  current: () => boolean;
  read: YearlyGoalReader;
  sender: YearlyGoalSender;
}) {
  let retired = false;
  let writing = false;
  let original: OriginalIntent | undefined;
  const aborts = new Set<AbortController>();
  const retire = () => {
    retired = true;
    original = undefined;
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
    async write(command) {
      if (!current() || command.year !== input.year) return { state: 'retired' };
      if (!input.csrfToken) return { state: 'denied' };
      if (writing || (original && original.source !== command)) return { state: 'uncertain' };
      // Ownership is synchronous, before credential preparation or any request can yield.
      writing = true;
      original ??= {
        source: command,
        command: Object.freeze({ ...command }),
        reader: Object.freeze({ expectedReader: input.viewer, expectedCredential: input.csrfToken }),
        sender: Object.freeze({ prepare: input.sender.prepare, write: input.sender.write }),
      };
      const intent = original;
      const abort = new AbortController();
      aborts.add(abort);
      try {
        if (!intent.credential) {
          let preparation: YearlyGoalPreparation;
          try {
            preparation = await intent.sender.prepare(intent.reader, abort.signal);
          } catch {
            // No PUT has been dispatched, so a failed credential capture is safely retryable as a fresh intent.
            original = undefined;
            return { state: current() ? 'unavailable' : 'retired' };
          }
          if (!current()) return { state: 'retired' };
          if (preparation.state !== 'ready') {
            original = undefined;
            return preparation;
          }
          intent.credential = preparation.credential;
        }
        if (!current()) return { state: 'retired' };
        let result: YearlyGoalWriteResult;
        try {
          result = await intent.sender.write(
            { ...intent.reader, credential: intent.credential, command: intent.command },
            abort.signal,
          );
        } catch {
          result = { state: 'uncertain' };
        }
        if (!current()) return { state: 'retired' };
        if (result.state !== 'uncertain') original = undefined;
        return result;
      } finally {
        writing = false;
        aborts.delete(abort);
      }
    },
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
      csrfToken: observation.csrfToken,
      read: readNative,
      sender: nativeSender,
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
      api={visit?.current() ? visit.api : undefined}
    />
  );
}
