import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { exposureQuery, useSession } from '../session/query';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { LabelsPageView } from './labels-page';
import type { LabelsPage } from './labels-read';
import { readLabelsCurrent, type LabelsAddress, type LabelsCurrentRead } from './labels-read-route';

const subscribe = () => () => {};
const labelOperations = ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'];
const signedOutPage: LabelsPage = {
  signedIn: false,
  operations: [],
  csrfToken: '',
  createKey: '',
  undoKey: '',
  labels: [],
  next: null,
};
function matches(value: LabelsCurrentRead | undefined, subject: string, address: LabelsAddress) {
  return (
    value?.sessionSubject === subject &&
    value.requested?.cursor === address.cursor &&
    value.requested.query === address.query &&
    value.requested.locale === address.locale &&
    (value.page.query ?? null) === address.query
  );
}

/** The route's private render boundary. Every observed replacement retires the originating handlers synchronously. */
export function LabelsCurrent({
  initial,
  search,
  locale,
}: {
  initial: LabelsCurrentRead;
  search: { cursor?: string; q?: string };
  locale: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const exposure = useQuery({ ...exposureQuery, enabled: hydrated && session.state === 'signed-in' });
  const subject = hydrated
    ? session.state === 'signed-in' && session.csrfToken
      ? session.subject
      : null
    : initial.sessionSubject;
  const admitted = hydrated ? exposure.data : initial.page.operations;
  const personal = admitted?.includes('personal_library') ?? false;
  const operations = labelOperations.filter((operation) => admitted?.includes(operation));
  const address: LabelsAddress = { cursor: search.cursor ?? null, query: search.q ?? null, locale };
  const key = JSON.stringify([subject, personal, operations, address]);
  const [scope, setScope] = useState({ key, generation: 0, seed: true });
  const origin = useRef({ key, active: true });
  if (origin.current.key !== key) {
    origin.current.active = false;
    origin.current = { key, active: true };
  }
  if (scope.key !== key) setScope({ key, generation: scope.generation + 1, seed: false });
  const currentOrigin = origin.current;
  useLayoutEffect(() => {
    currentOrigin.active = true;
    return () => {
      currentOrigin.active = false;
    };
  }, [currentOrigin]);
  if (!subject) {
    if (!hydrated)
      return (
        <LabelsPageView
          page={{ ...signedOutPage, ...(initial.page.state ? { state: initial.page.state } : {}) }}
          locale={locale}
        />
      );
    if (session.state === 'signed-out') return <LabelsPageView page={signedOutPage} locale={locale} />;
    return <p role="status">{m.library_labels_unavailable()}</p>;
  }
  if (!personal || !operations.includes('library_label.list'))
    return <p role="status">{admitted ? m.library_subject_label_closed() : m.library_labels_unavailable()}</p>;
  return (
    <LabelsRead
      key={scope.generation}
      subject={subject}
      address={address}
      operations={operations}
      initial={initial}
      seed={scope.seed}
      hydrated={hydrated}
      origin={currentOrigin}
    />
  );
}

function LabelsRead({
  subject,
  address,
  operations,
  initial,
  seed,
  hydrated,
  origin,
}: {
  subject: string;
  address: LabelsAddress;
  operations: string[];
  initial: LabelsCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: { active: boolean };
}) {
  const client = useQueryClient();
  const [lifetime] = useState(() => crypto.randomUUID());
  const [rejected, setRejected] = useState(false);
  const queryKey = ['labels-current', subject, 'personal_library', operations, address, lifetime] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled && !rejected,
    queryFn: async () => {
      if (!origin.active) throw new Error('Obsolete Labels read');
      const value = await readLabelsCurrent({
        data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
      });
      if (!origin.active || !matches(value, subject, address)) throw new Error('Unaccepted Labels read');
      return value;
    },
    initialData: seed && matches(initial, subject, address) ? initial : undefined,
    // The loader already performed this bounded read. Hydration must not add another one.
    staleTime: Infinity,
    refetchOnMount: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  const [loader, setLoader] = useState({ value: initial, valid: true });
  if (loader.value !== initial) setLoader({ value: initial, valid: matches(initial, subject, address) });
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (origin.active && matches(initial, subject, address)) client.setQueryData(queryKey, initial);
  }, [initial, subject, address, client, origin, queryKey]);
  const accepted =
    !rejected && loader.valid && !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  const current = useRef(false);
  current.current = !!accepted;
  const [isCurrent] = useState(() => () => origin.active && current.current);
  const [refresh] = useState(() => async () => {
    if (!isCurrent()) return null;
    const value = await readLabelsCurrent({
      data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
    });
    if (!isCurrent()) return null;
    if (!matches(value, subject, address)) {
      origin.active = false;
      setRejected(true);
      return null;
    }
    return { ...value.page, operations: value.page.operations.filter((operation) => operations.includes(operation)) };
  });
  const admission = operations.join('|');
  const page = useMemo(
    () =>
      accepted
        ? {
            ...accepted.page,
            operations: accepted.page.operations.filter((operation) => operations.includes(operation)),
          }
        : undefined,
    [accepted, admission],
  );
  if (!page) return <p role="status">{m.library_labels_unavailable()}</p>;
  return (
    <LabelsPageView
      page={page}
      isCurrent={isCurrent}
      refresh={refresh}
      {...(address.cursor === null ? {} : { cursor: address.cursor })}
      locale={address.locale}
    />
  );
}
