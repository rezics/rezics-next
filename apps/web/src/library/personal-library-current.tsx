import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { PersonalLibraryPage } from './entries-page';
import { EntriesFirstPage } from './entries-current';
import { shelfMutationLease, type ShelfMutationLease } from './shelf-rows';
import {
  personalLibraryAddress,
  samePersonalLibraryAddress,
  readPersonalLibraryCurrent,
  readPersonalLibraryContinue,
  type PersonalLibraryCurrentRead,
  type PersonalLibraryAddress,
} from './personal-library-server';
import type { ShelfDisplay, ShelfSearch } from './shelf-params';
import type { ShelfPresentationResolution } from './shelf-preferences';
import { PersonalShelfOrigin, usePersonalShelfObservation, type ShelfOrigin } from './personal-shelf-origin';

import { ShelfSummaryAcknowledgement, useShelfSummaryCurrent } from './shelf-summary-current';
import { ShelfSummaryCount, ShelfSummaryNavigation, type ShelfSummaryPresentation } from './shelf-summary-view';

const subscribe = () => () => {};
function matches(value: PersonalLibraryCurrentRead | undefined, subject: string, address: PersonalLibraryAddress) {
  return value?.sessionSubject === subject && samePersonalLibraryAddress(value.requested, address);
}

/** The actual personal route's render boundary, including its native shelf children. */
export function PersonalLibraryCurrent({
  initial,
  search,
  locale,
  display,
  presentation,
}: {
  initial: PersonalLibraryCurrentRead;
  search: ShelfSearch;
  locale: string;
  display: ShelfDisplay;
  presentation?: ShelfPresentationResolution;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  useOperation('library_entry.list');
  useOperation('progress_session.list');
  const pins = useOperation('library_pin.list');
  const collections = useOperation('collection.list');
  useOperation('library_label.list');
  useOperation('library_continue.list');
  useOperation('library_label.assign');
  const address = personalLibraryAddress(search, locale);
  const { observation, value } = usePersonalShelfObservation(address);
  const browser = useRef(hydrated);
  browser.current = hydrated;
  const subject = hydrated ? value.subject : initial.sessionSubject;
  const admitted = !search.label;
  const key = JSON.stringify([subject, value.scope, address]);
  const [scope, setScope] = useState({ key, generation: 0, seed: true, hydrated });
  const origin = useRef<{ key: string; active: boolean; mounted: boolean | undefined; authority: ShelfOrigin } | null>(
    null,
  );
  if (origin.current?.key !== key) {
    if (origin.current) origin.current.active = false;
    const lifetime = {
      key,
      active: true,
      mounted: undefined,
      authority: null as unknown as ShelfOrigin,
    };
    const current = () =>
      lifetime.active &&
      lifetime.mounted !== false &&
      (!browser.current ||
        (observation.read().scope === value.scope &&
          observation.read().subject === subject &&
          observation.at(address)));
    lifetime.authority = {
      current,
      viewer: () => (current() ? observation.read().subject : null),
      capture: (...ops) => {
        let version: string | undefined;
        if (browser.current) {
          observation.read();
          version = observation.epoch(...ops);
        }
        return () => {
          if (!current()) return false;
          if (!browser.current) return true;
          version ??= observation.epoch(...ops);
          return observation.allowed(...ops) && observation.epoch(...ops) === version;
        };
      },
      version: (...ops) => {
        observation.read();
        return observation.version(...ops);
      },
      epoch: observation.epoch,
      retains: observation.retains,
      watch: observation.watch,
      headers: observation.headers,
    };
    origin.current = lifetime;
  }
  if (scope.key !== key)
    setScope({
      key,
      generation: scope.generation + 1,
      seed: scope.seed && !scope.hydrated && !!subject && admitted,
      hydrated,
    });
  else if (scope.hydrated !== hydrated) setScope({ ...scope, hydrated });
  const summary = useShelfSummaryCurrent(origin.current.authority, subject, address.type, locale, hydrated);
  const mountedOrigin = origin.current;
  useLayoutEffect(() => {
    if (mountedOrigin.active) mountedOrigin.mounted = true;
    return () => {
      mountedOrigin.mounted = false;
    };
  }, [mountedOrigin]);
  const [lease, setLease] = useState(() => ({ key, value: shelfMutationLease() }));
  if (lease.key !== key) setLease({ key, value: shelfMutationLease() });
  if (!subject || !admitted || (hydrated && !observation.at(address)))
    return (
      <p role="status">
        {search.label
          ? m.library_sort_preparing()
          : session.state === 'signed-out'
            ? m.library_sign_in()
            : !admitted
              ? m.library_sort_denied()
              : m.library_sort_preparing()}
      </p>
    );
  return (
    <ShelfSummaryAcknowledgement.Provider value={summary.acknowledge}>
      <PersonalLibraryRead
        summary={summary}
        key={scope.generation}
        subject={subject}
        address={address}
        initial={initial}
        seed={scope.seed}
        hydrated={hydrated}
        display={display}
        {...(presentation ? { presentation } : {})}
        origin={origin.current.authority}
        mutationLease={lease.value}
        input={search}
        pinsAdmitted={!hydrated || pins}
        collectionsAdmitted={!hydrated || collections}
      />
    </ShelfSummaryAcknowledgement.Provider>
  );
}

function PersonalLibraryRead({
  summary,
  subject,
  address,
  initial,
  seed,
  hydrated,
  display,
  presentation,
  origin,
  input,
  pinsAdmitted,
  collectionsAdmitted,
  mutationLease,
}: {
  summary: ShelfSummaryPresentation;
  subject: string;
  address: PersonalLibraryAddress;
  initial: PersonalLibraryCurrentRead;
  seed: boolean;
  hydrated: boolean;
  display: ShelfDisplay;
  presentation?: ShelfPresentationResolution;
  origin: ShelfOrigin;
  input: ShelfSearch;
  pinsAdmitted: boolean;
  collectionsAdmitted: boolean;
  mutationLease: ShelfMutationLease;
}) {
  const client = useQueryClient();
  const [lifetime] = useState(() => crypto.randomUUID());
  const queryKey = ['personal-library-current', subject, address, lifetime];
  const browser = useRef(hydrated);
  browser.current = hydrated;
  const seedVersions = useRef({ entries: null as string | null, continue: null as string | null });
  const envelope = (value: PersonalLibraryCurrentRead) => ({
    value,
    entries: browser.current ? origin.version('library_entry.list', 'progress_session.list') : null,
    continue: browser.current ? origin.version('library_continue.list', 'progress_session.list') : null,
  });
  const regionAdmitted = (region: 'entries' | 'continue') => {
    if (!origin.current()) return false;
    if (!browser.current) return true;
    const ops = [
      region === 'entries' ? 'library_entry.list' : 'library_continue.list',
      'progress_session.list',
    ] as const;
    return origin.capture(...ops)();
  };
  const regionCurrent = (read: ReturnType<typeof envelope>, region: 'entries' | 'continue') => {
    const version = origin.version(
      region === 'entries' ? 'library_entry.list' : 'library_continue.list',
      'progress_session.list',
    );
    seedVersions.current[region] ??= version;
    return regionAdmitted(region) && version === (read[region] ?? seedVersions.current[region]);
  };
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? envelope(initial) : undefined));
  const enabled =
    hydrated &&
    personalRead.enabled &&
    (origin.capture('library_entry.list', 'progress_session.list')() ||
      origin.capture('library_continue.list', 'progress_session.list')());
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled,
    queryFn: async () => {
      if (!origin.current()) throw new CancelledError({ silent: true, revert: true });
      const guards = envelope(initial);
      const entriesCurrent = origin.capture('library_entry.list', 'progress_session.list');
      const continueCurrent = origin.capture('library_continue.list', 'progress_session.list');
      if (!regionCurrent(guards, 'entries') && !regionCurrent(guards, 'continue'))
        throw new Error('Unadmitted personal Library read');
      let value: PersonalLibraryCurrentRead;
      try {
        value = await readPersonalLibraryCurrent({ data: input });
      } catch (error) {
        if (!origin.current() || (!entriesCurrent() && !continueCurrent()))
          throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
      if (!origin.current() || (!entriesCurrent() && !continueCurrent()))
        throw new CancelledError({ silent: true, revert: true });
      if (!matches(value, subject, address)) throw new Error('Unaccepted personal Library read');
      return {
        ...guards,
        value: {
          ...value,
          page:
            entriesCurrent() && regionCurrent(guards, 'entries')
              ? value.page
              : {
                  signedIn: true,
                  entries: [],
                  next: null,
                  readState: 'denied',
                  sort: { orderBy: address.orderBy, direction: address.direction },
                  ...(address.type ? { type: address.type } : {}),
                  ...(address.state ? { state: address.state } : {}),
                },
          continueEntries:
            continueCurrent() && regionCurrent(guards, 'continue')
              ? value.continueEntries
              : { state: 'denied', status: 403 },
        } satisfies PersonalLibraryCurrentRead,
      };
    },
    initialData,
    staleTime: Infinity,
    refetchOnMount: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  useEffect(() => {
    const previous = previousLoader.current;
    previousLoader.current = initial;
    if (previous !== initial) {
      if (
        enabled &&
        origin.current() &&
        (origin.capture('library_entry.list', 'progress_session.list')() ||
          origin.capture('library_continue.list', 'progress_session.list')())
      )
        void query.refetch();
    }
  }, [initial, enabled, query.refetch, origin]);
  const actualRead = client.getQueryState<ReturnType<typeof envelope>>(queryKey);
  const accepted =
    !query.isError &&
    actualRead?.status === 'success' &&
    matches(actualRead.data?.value, subject, address) &&
    matches(query.data?.value, subject, address)
      ? query.data
      : undefined;
  const readLifetime = useMemo(() => {
    let generation = 0;
    let token = {};
    let previousValue: unknown;
    let invalid = false;
    let seen = false;
    const listeners = new Set<() => void>();
    const read = () => {
      const actual = client.getQueryState<ReturnType<typeof envelope>>(queryKey);
      const valid = actual?.status === 'success' && matches(actual.data?.value, subject, address);
      const next = actual?.status === 'error' || (seen && !valid) || (actual?.status === 'success' && !valid);
      if (seen && actual?.data !== previousValue) token = {};
      previousValue = actual?.data;
      seen ||= valid;
      if (next && !invalid) generation++;
      invalid = next;
      return generation;
    };
    return {
      read,
      token: () => {
        read();
        return token;
      },
      server: () => 0,
      watch: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        const unsubscribe = client.getQueryCache().subscribe(({ query }) => {
          if (query.queryKey[0] !== 'personal-library-current' || query.queryKey.at(-1) !== lifetime) return;
          const before = generation;
          const beforeToken = token;
          read();
          if (generation !== before || token !== beforeToken) listeners.forEach((listener) => listener());
        });
        return () => {
          listeners.delete(notify);
          unsubscribe();
        };
      },
    };
  }, [client, origin]);
  const readGeneration = useSyncExternalStore(readLifetime.subscribe, readLifetime.read, readLifetime.server);
  const readToken = readLifetime.token();
  const isCurrent = useMemo(
    () => () => {
      const actual = client.getQueryState<ReturnType<typeof envelope>>(queryKey);
      return (
        origin.current() &&
        readLifetime.read() === readGeneration &&
        readLifetime.token() === readToken &&
        actual?.status === 'success' &&
        actual.data === accepted &&
        matches(actual.data?.value, subject, address)
      );
    },
    [origin, readGeneration, readToken, accepted],
  );
  const pageOrigin = useMemo<ShelfOrigin>(
    () => ({
      ...origin,
      current: isCurrent,
      capture: (...ops) => {
        const current = origin.capture('library_entry.list', 'progress_session.list', ...ops);
        return () => isCurrent() && current();
      },
      watch: (listener) => {
        const authority = origin.watch(listener);
        const read = readLifetime.watch(listener);
        return () => {
          authority();
          read();
        };
      },
    }),
    [origin, isCurrent],
  );
  const continueEpoch = origin.epoch?.('library_continue.list', 'progress_session.list');
  const continueCurrent = useMemo(() => {
    const current = origin.capture('library_continue.list', 'progress_session.list');
    return () => isCurrent() && current();
  }, [origin, isCurrent, continueEpoch]);
  const readContinue = useMemo(() => {
    const currentRead = () =>
      continueCurrent() && client.getQueryData(queryKey) === accepted && !!accepted && regionAdmitted('continue');
    return async () => {
      if (!currentRead()) return { state: 'unavailable' } as const;
      const result = await readPersonalLibraryContinue({
        data: {
          type: address.type ?? undefined,
          state: address.state ?? undefined,
          cursor: address.cursor ?? undefined,
          orderBy: address.orderBy,
          direction: address.direction,
        },
      });
      return currentRead() && result.sessionSubject === subject && samePersonalLibraryAddress(result.requested, address)
        ? result.result
        : ({ state: 'unavailable' } as const);
    };
  }, [origin, accepted, continueCurrent]);
  if (!accepted)
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-3xl font-semibold">
          {m.library_heading()}
          <ShelfSummaryCount page={summary.page} locale={address.locale} />
        </h1>
        <ShelfSummaryNavigation
          summary={summary}
          locale={address.locale}
          view={presentation?.intent ?? input}
        />
        <p role={query.isError || query.data ? 'alert' : 'status'}>
          {query.isError || query.data ? m.error_message() : m.library_sort_preparing()}
        </p>
        {query.isError || query.data ? (
          <EntriesFirstPage locale={address.locale} view={presentation?.intent ?? input} />
        ) : null}
      </div>
    );
  return (
    <div>
      <PersonalShelfOrigin.Provider value={pageOrigin}>
        <PersonalLibraryPage
          key={readGeneration}
          summary={summary}
          page={accepted.value.page}
          entriesAdmitted={regionAdmitted('entries')}
          locale={address.locale}
          display={display}
          {...(presentation ? { presentation } : {})}
          {...(address.cursor ? { cursor: address.cursor } : {})}
          acceptedNavigation={{
            pins: pinsAdmitted ? accepted.value.navigation.pins : { state: 'closed' },
            collections: collectionsAdmitted ? accepted.value.navigation.collections : [],
            collectionsState: collectionsAdmitted ? (accepted.value.navigation.collectionsState ?? 'loaded') : 'loaded',
          }}
          continueState={accepted.value.continueEntries}
          continueAdmitted={regionAdmitted('continue')}
          continueRead={readContinue}
          continueCurrent={continueCurrent}
          continueScope={JSON.stringify([address, continueEpoch, readGeneration])}
          isCurrent={isCurrent}
          originatingLease={mutationLease}
        />
      </PersonalShelfOrigin.Provider>
    </div>
  );
}
