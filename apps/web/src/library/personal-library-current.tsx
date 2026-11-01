import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const entries = useOperation('library_entry.list');
  const progress = useOperation('progress_session.list');
  const pins = useOperation('library_pin.list');
  const collections = useOperation('collection.list');
  const labels = useOperation('library_label.list');
  const continueList = useOperation('library_continue.list');
  const labelAssign = useOperation('library_label.assign');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = !search.label && (!hydrated || (entries && progress && continueList));
  const address = personalLibraryAddress(search, locale);
  const actorKey = JSON.stringify([subject, admitted, hydrated ? [pins, collections, labels, labelAssign] : null]);
  const [lease, setLease] = useState(() => ({ key: actorKey, value: shelfMutationLease() }));
  if (lease.key !== actorKey) setLease({ key: actorKey, value: shelfMutationLease() });
  const key = JSON.stringify([actorKey, address]);
  // Admission initialization at hydration may keep the actual server seed, but a later retirement cannot reuse it.
  const [scope, setScope] = useState({ key, generation: 0, seed: true, hydrated });
  const origin = useRef({ key, active: true });
  if (origin.current.key !== key) {
    origin.current.active = false;
    origin.current = { key, active: true };
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
    origin.current.active = true;
    return () => {
      origin.current.active = false;
    };
  }, []);
  if (!subject || !admitted)
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
      origin={origin.current}
      mutationLease={lease.value}
      input={search}
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
}: {
  subject: string;
  address: PersonalLibraryAddress;
  initial: PersonalLibraryCurrentRead;
  seed: boolean;
  hydrated: boolean;
  display: ShelfDisplay;
  origin: { active: boolean };
  input: ShelfSearch;
  pinsAdmitted: boolean;
  collectionsAdmitted: boolean;
  mutationLease: ShelfMutationLease;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const query = useQuery({
    ...personalRead,
    queryKey: ['personal-library-current', subject, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active) throw new Error('Obsolete personal Library read');
      const value = await readPersonalLibraryCurrent({ data: input });
      if (!origin.active || !matches(value, subject, address)) throw new Error('Unaccepted personal Library read');
      return value;
    },
    initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current !== initial) {
      previousLoader.current = initial;
      void query.refetch();
    }
  }, [initial, query.refetch]);
  const accepted = !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  const current = useRef(false);
  current.current = !!accepted;
  const [isCurrent] = useState(() => () => origin.active && current.current);
  const [readContinue] = useState(() => async () => {
    if (!isCurrent()) return { state: 'unavailable' } as const;
    const result = await readPersonalLibraryContinue({
      data: {
        type: address.type ?? undefined,
        state: address.state ?? undefined,
        cursor: address.cursor ?? undefined,
        orderBy: address.orderBy,
        direction: address.direction,
      },
    });
    return isCurrent() && result.sessionSubject === subject && samePersonalLibraryAddress(result.requested, address)
      ? result.result
      : ({ state: 'unavailable' } as const);
  });
  if (!accepted)
    return <p role="status">{query.isError || query.data ? m.error_message() : m.library_sort_preparing()}</p>;
  return (
    <PersonalLibraryPage
      page={accepted.page}
      locale={address.locale}
      display={display}
      {...(address.cursor ? { cursor: address.cursor } : {})}
      acceptedNavigation={{
        pins: pinsAdmitted ? accepted.navigation.pins : { state: 'closed' },
        collections: collectionsAdmitted ? accepted.navigation.collections : [],
        collectionsState: collectionsAdmitted ? (accepted.navigation.collectionsState ?? 'loaded') : 'loaded',
      }}
      continueState={accepted.continueEntries}
      continueRead={readContinue}
      isCurrent={isCurrent}
      originatingLease={mutationLease}
    />
  );
}
