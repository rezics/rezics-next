import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { exposureQuery, useSession } from '../session/query';
import { operationIsAdmitted } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { LabelsPageView } from './labels-page';
import type { LabelsPage } from './labels-read';
import { readLabelsCurrent, type LabelsAddress, type LabelsCurrentRead } from './labels-read-route';
import { useManagementCurrentOrigin, type ManagementGuard } from './management-current-origin';

const subscribe = () => () => {};
const closed: ManagementGuard = { isCurrent: () => false, headers: () => null };
const labelOperations = [
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
] as const;
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
    value.page?.signedIn &&
    value.requested?.cursor === address.cursor &&
    value.requested.query === address.query &&
    value.requested.locale === address.locale &&
    (value.page.query ?? null) === address.query
  );
}

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
      ? (session.subject ?? null)
      : null
    : initial.sessionSubject;
  const admitted = hydrated && !exposure.isError ? exposure.data : !hydrated ? initial.page.operations : undefined;
  const allowed = operationIsAdmitted('library_label.list', admitted);
  const address: LabelsAddress = { cursor: search.cursor ?? null, query: search.q ?? null, locale };
  const origin = useManagementCurrentOrigin(subject, JSON.stringify(address), 'library_label.list', hydrated);
  const [scope, setScope] = useState({ id: origin.id, seed: true, hydrated });
  if (scope.id !== origin.id) setScope({ id: origin.id, seed: scope.seed && !scope.hydrated && !!subject, hydrated });
  else if (scope.hydrated !== hydrated) setScope({ ...scope, hydrated });
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
  if (!allowed)
    return <p role="status">{admitted ? m.library_subject_label_closed() : m.library_labels_unavailable()}</p>;
  return (
    <LabelsRead
      key={origin.id}
      subject={subject}
      address={address}
      initial={initial}
      seed={scope.seed}
      hydrated={hydrated}
      origin={origin}
    />
  );
}

function LabelsRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
}: {
  subject: string;
  address: LabelsAddress;
  initial: LabelsCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: ReturnType<typeof useManagementCurrentOrigin>;
}) {
  const client = useQueryClient();
  const [lifetime] = useState(() => crypto.randomUUID());
  const queryKey = ['labels-current', subject, address, lifetime] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) throw new Error('Obsolete Labels read');
      try {
        const value = await readLabelsCurrent({
          data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
        });
        if (!origin.isCurrent() || !matches(value, subject, address)) throw new Error('Unaccepted Labels read');
        return value;
      } catch (error) {
        if (!origin.isCurrent()) throw new Error('Obsolete Labels read');
        throw error;
      }
    },
    initialData: seed && matches(initial, subject, address) ? initial : undefined,
    staleTime: Infinity,
    refetchOnMount: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  const [loader, setLoader] = useState(initial);
  if (loader !== initial) {
    setLoader(initial);
    if (!matches(initial, subject, address)) origin.rejectRead();
  }
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (!origin.isCurrent()) return;
    if (matches(initial, subject, address)) client.setQueryData(queryKey, initial);
    else origin.rejectRead();
  }, [initial, subject, address, client, origin, queryKey]);
  const accepted = !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  const guard = accepted
    ? origin.accept(
        queryKey,
        (value) =>
          matches(value as LabelsCurrentRead, subject, address) &&
          (value as LabelsCurrentRead).page.operations.includes('library_label.list') &&
          (!(value as LabelsCurrentRead).page.state || (value as LabelsCurrentRead).page.state === 'loaded'),
        labelOperations,
      )
    : null;
  const page = accepted?.page;
  if (!page || (hydrated && !guard && (!page.state || page.state === 'loaded')))
    return (
      <div>
        <p role="status">{m.library_labels_unavailable()}</p>
        {hydrated && !query.isFetching ? (
          <button
            type="button"
            onClick={() => {
              if (origin.isCurrent()) void query.refetch();
            }}
          >
            {m.subject_view_retry()}
          </button>
        ) : null}
      </div>
    );
  return (
    <LabelsPageView
      key={origin.id}
      page={page}
      isCurrent={guard?.isCurrent ?? (hydrated ? origin.isCurrent : closed.isCurrent)}
      originating={guard ?? closed}
      refresh={async () => {
        if (!guard?.isCurrent('library_label.list')) return null;
        const value = await readLabelsCurrent({
          data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
        });
        if (!guard.isCurrent('library_label.list')) return null;
        if (!matches(value, subject, address)) {
          origin.rejectRead();
          return null;
        }
        return value.page;
      }}
      {...(address.cursor === null ? {} : { cursor: address.cursor })}
      locale={address.locale}
    />
  );
}
