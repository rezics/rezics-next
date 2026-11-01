import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { CopiesPage, type CopiesOrigin } from './copies-page';
import {
  copiesAddress,
  sameCopiesAddress,
  readCopiesCurrent,
  readCopyDetailCurrent,
  readCopySubjectCurrent,
  type CopiesAddress,
  type CopiesCurrentRead,
} from './copies-actions';

const subscribe = () => () => {};
function matches(value: CopiesCurrentRead | undefined, subject: string, address: CopiesAddress) {
  return (
    value?.sessionSubject === subject &&
    sameCopiesAddress(value.requested, address) &&
    value.page.signedIn &&
    value.page.subjectId === address.subjectId &&
    (!address.subjectId || value.page.copies.every((copy) => !copy.subject || copy.subject.id === address.subjectId))
  );
}

/** The route's private render boundary. Identity/admission/address retire work during render. */
export function CopiesCurrent({
  initial,
  search,
  locale,
  failure,
}: {
  initial: CopiesCurrentRead;
  search: { subjectId?: string; cursor?: string };
  locale: string;
  failure?: string | undefined;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const admitted = useOperation('copy.list');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const allowed = !hydrated || admitted;
  const address = copiesAddress(search, locale);
  const key = JSON.stringify([subject, allowed, address]);
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
      seed: scope.seed && !scope.hydrated && !!subject && allowed,
      hydrated,
    });
  else if (scope.hydrated !== hydrated) setScope({ ...scope, hydrated });
  useLayoutEffect(() => {
    const mounted = origin.current;
    mounted.active = true;
    return () => {
      mounted.active = false;
      origin.current.active = false;
    };
  }, []);
  if (!subject || !allowed)
    return (
      <p role="status">
        {session.state === 'signed-out'
          ? m.library_sign_in()
          : !allowed
            ? m.library_sort_denied()
            : m.library_sort_preparing()}
      </p>
    );
  return (
    <CurrentCopiesRead
      key={scope.generation}
      subject={subject}
      address={address}
      initial={initial}
      seed={scope.seed}
      hydrated={hydrated}
      origin={origin.current}
      csrfToken={session.csrfToken}
      failure={failure}
    />
  );
}

function CurrentCopiesRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
  csrfToken,
  failure,
}: {
  subject: string;
  address: CopiesAddress;
  initial: CopiesCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: { active: boolean };
  csrfToken: string | null;
  failure?: string | undefined;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const input = { subjectId: address.subjectId ?? undefined, cursor: address.cursor ?? undefined };
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    ...personalRead,
    queryKey: ['copies-current', subject, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active || !mounted.current) throw new Error('Obsolete Copies read');
      const value = await readCopiesCurrent({ data: input });
      if (!origin.active || !mounted.current || !matches(value, subject, address))
        throw new Error('Unaccepted Copies read');
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
  const token = useRef<string | null>(null);
  // A browser token is associated only after the observed viewer agrees with the actual read.
  token.current = accepted ? (hydrated ? csrfToken : (accepted.page.csrfToken ?? null)) : null;
  const [operand] = useState<CopiesOrigin>(() => {
    const isCurrent = () => origin.active && mounted.current && current.current;
    return {
      isCurrent,
      headers: () => (isCurrent() && token.current ? { 'x-csrf-token': token.current } : null),
      readDetail: async (id) => {
        if (!isCurrent()) return { ok: false, reason: 'unavailable' };
        const value = await readCopyDetailCurrent({ data: { ...input, id } });
        if (
          !isCurrent() ||
          value.sessionSubject !== subject ||
          !sameCopiesAddress(value.requested, address) ||
          value.id !== id ||
          (value.result.ok &&
            (value.result.copy.id !== id ||
              (address.subjectId && value.result.copy.subject && value.result.copy.subject.id !== address.subjectId)))
        )
          return { ok: false, reason: 'unavailable' };
        return value.result;
      },
      readSubject: async (id) => {
        if (!isCurrent()) return { state: 'unavailable' };
        const value = await readCopySubjectCurrent({ data: { ...input, id } });
        if (
          !isCurrent() ||
          value.sessionSubject !== subject ||
          !sameCopiesAddress(value.requested, address) ||
          value.id !== id ||
          (value.result.state === 'ready' && value.result.subject.id !== id)
        )
          return { state: 'unavailable' };
        return value.result;
      },
    };
  });
  if (!accepted)
    return <p role="status">{query.isError || query.data ? m.error_message() : m.library_sort_preparing()}</p>;
  return <CopiesPage page={accepted.page} failure={failure} originating={operand} />;
}
