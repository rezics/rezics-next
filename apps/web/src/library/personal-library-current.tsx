import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { PersonalLibraryPage } from './entries-page';
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
import { PersonalShelfOrigin, usePersonalShelfObservation, type ShelfOrigin } from './personal-shelf-origin';

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
}: {
  initial: PersonalLibraryCurrentRead;
  search: ShelfSearch;
  locale: string;
  display: ShelfDisplay;
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
  const origin = useRef<{ key: string; active: boolean; authority: ShelfOrigin } | null>(null);
  if (origin.current?.key !== key) {
    if (origin.current) origin.current.active = false;
    const lifetime = {
      key,
      active: true,
      authority: null as unknown as ShelfOrigin,
    };
    const current = () =>
      lifetime.active &&
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
          version = observation.version(...ops);
        }
        return () => {
          if (!current()) return false;
          if (!browser.current) return true;
          version ??= observation.version(...ops);
          return observation.allowed(...ops) && observation.version(...ops) === version;
        };
      },
      version: (...ops) => {
        observation.read();
        return observation.version(...ops);
      },
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
  useLayoutEffect(() => {
    origin.current!.active = true;
    return () => {
      origin.current!.active = false;
    };
  }, []);
  const [lease, setLease] = useState(() => ({ key, value: shelfMutationLease() }));
  if (lease.key !== key) setLease({ key, value: shelfMutationLease() });
  if (!subject || !admitted || (hydrated && !origin.current.authority.current()))
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
    <PersonalLibraryRead
      key={scope.generation}
      subject={subject}
      address={address}
      initial={initial}
      seed={scope.seed}
      hydrated={hydrated}
      display={display}
      origin={origin.current.authority}
      mutationLease={lease.value}
      input={search}
      readVersion={value.versions.slice(0, 3).join(':')}
      pinsAdmitted={!hydrated || pins}
      collectionsAdmitted={!hydrated || collections}
    />
  );
}

function PersonalLibraryRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  display,
  origin,
  input,
  pinsAdmitted,
  collectionsAdmitted,
  mutationLease,
  readVersion,
}: {
  subject: string;
  address: PersonalLibraryAddress;
  initial: PersonalLibraryCurrentRead;
  seed: boolean;
  hydrated: boolean;
  display: ShelfDisplay;
  origin: ShelfOrigin;
  readVersion: string;
  input: ShelfSearch;
  pinsAdmitted: boolean;
  collectionsAdmitted: boolean;
  mutationLease: ShelfMutationLease;
}) {
  const client = useQueryClient();
  const [lifetime] = useState(() => crypto.randomUUID());
  const queryKey = ['personal-library-current', subject, address, lifetime];
  const envelope = (value: PersonalLibraryCurrentRead) => ({
    value,
    entries: origin.capture('library_entry.list', 'progress_session.list'),
    continue: origin.capture('library_continue.list', 'progress_session.list'),
  });
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? envelope(initial) : undefined));
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.current()) throw new Error('Obsolete personal Library read');
      const guards = envelope(initial);
      const value = await readPersonalLibraryCurrent({ data: input });
      if (!origin.current() || !matches(value, subject, address)) throw new Error('Unaccepted personal Library read');
      return { ...guards, value };
    },
    initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef({ initial, readVersion });
  useEffect(() => {
    if (previousLoader.current.initial !== initial || previousLoader.current.readVersion !== readVersion) {
      previousLoader.current = { initial, readVersion };
      if (
        origin.current() &&
        (origin.capture('library_entry.list', 'progress_session.list')() ||
          origin.capture('library_continue.list', 'progress_session.list')())
      )
        void query.refetch();
    }
  }, [initial, readVersion, query.refetch, origin]);
  const accepted = !query.isError && matches(query.data?.value, subject, address) ? query.data : undefined;
  const current = useRef(false);
  current.current = !!accepted;
  const [isCurrent] = useState(() => () => {
    const actual = client.getQueryState<ReturnType<typeof envelope>>(queryKey);
    return (
      origin.current() &&
      current.current &&
      actual?.status === 'success' &&
      matches(actual.data?.value, subject, address)
    );
  });
  const [pageOrigin] = useState<ShelfOrigin>(() => ({
    ...origin,
    current: isCurrent,
    capture: (...ops) => {
      const current = origin.capture('library_entry.list', 'progress_session.list', ...ops);
      return () => isCurrent() && current();
    },
  }));
  const readContinue = useMemo(
    () => async () => {
      const current = origin.capture('library_continue.list', 'progress_session.list');
      const currentRead = () =>
        isCurrent() && client.getQueryData(queryKey) === accepted && !!accepted?.continue() && current();
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
    },
    [origin, accepted],
  );
  if (!accepted)
    return <p role="status">{query.isError || query.data ? m.error_message() : m.library_sort_preparing()}</p>;
  return (
    <PersonalShelfOrigin.Provider value={pageOrigin}>
      <PersonalLibraryPage
        page={
          accepted.entries()
            ? accepted.value.page
            : {
                signedIn: true,
                entries: [],
                next: null,
                readState: 'denied',
                sort: { orderBy: address.orderBy, direction: address.direction },
                ...(address.type ? { type: address.type } : {}),
                ...(address.state ? { state: address.state } : {}),
              }
        }
        locale={address.locale}
        display={display}
        {...(address.cursor ? { cursor: address.cursor } : {})}
        acceptedNavigation={{
          pins: pinsAdmitted ? accepted.value.navigation.pins : { state: 'closed' },
          collections: collectionsAdmitted ? accepted.value.navigation.collections : [],
          collectionsState: collectionsAdmitted ? (accepted.value.navigation.collectionsState ?? 'loaded') : 'loaded',
        }}
        continueState={accepted.continue() ? accepted.value.continueEntries : { state: 'denied' }}
        continueRead={readContinue}
        isCurrent={isCurrent}
        originatingLease={mutationLease}
      />
    </PersonalShelfOrigin.Provider>
  );
}
