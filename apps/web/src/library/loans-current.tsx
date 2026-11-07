import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { LoansPage, type LoansOrigin } from './loans-page';
import { useManagementCurrentOrigin } from './management-current-origin';
import { loansAddress, sameLoansAddress, type LoansAddress } from './loans-query';
import { readLoansCurrent, type LoansCurrentRead } from './loans-actions';

const subscribe = () => () => {};
const closed: LoansOrigin = { isCurrent: () => false, headers: () => null };
const operations = ['copy.list', 'copy.create', 'copy.update'] as const;

function matches(value: LoansCurrentRead | undefined, subject: string, address: LoansAddress) {
  return (
    value?.sessionSubject === subject &&
    !!value.requested &&
    sameLoansAddress(value.requested, address) &&
    value.page?.signedIn &&
    value.page.filter === address.filter &&
    (value.page.requestedCursor ?? null) === address.cursor
  );
}

export function LoansCurrent({
  initial,
  search,
  locale,
}: {
  initial: LoansCurrentRead;
  search: { filter?: unknown; cursor?: unknown };
  locale: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const { value } = useLibraryWorkspaceAdmission(operations);
  const subject = hydrated ? value.subject : initial.sessionSubject;
  const allowed = !hydrated || value.allowed[0] === true;
  const address = useMemo(() => loansAddress(search, locale), [search, locale]);
  const origin = useManagementCurrentOrigin(subject, JSON.stringify(address), 'copy.list', hydrated, operations);
  const [scope, setScope] = useState({ id: origin.id, seed: true, hydrated });
  if (scope.id !== origin.id)
    setScope({ id: origin.id, seed: scope.seed && !scope.hydrated && !!subject && allowed, hydrated });
  else if (scope.hydrated !== hydrated) setScope({ ...scope, hydrated });
  const shown = useRef<string | null>(null);
  if (allowed) shown.current = origin.id;
  if (!subject || (!allowed && shown.current !== origin.id))
    return (
      <p role="status">
        {session.state === 'signed-out'
          ? m.library_sign_in()
          : !allowed
            ? m.library_sort_denied()
            : m.library_sort_preparing()}
      </p>
    );
  if (address.issue) return <p role="alert">{m.library_loans_invalid()}</p>;
  return (
    <>
      {!allowed ? <p role="status">{m.library_sort_preparing()}</p> : null}
      <div hidden={!allowed}>
        <CurrentLoansRead
          key={origin.id}
          subject={subject}
          address={address}
          initial={initial}
          seed={scope.seed}
          hydrated={hydrated}
          origin={origin}
        />
      </div>
    </>
  );
}

function CurrentLoansRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
}: {
  subject: string;
  address: LoansAddress;
  initial: LoansCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: ReturnType<typeof useManagementCurrentOrigin>;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const queryClient = useQueryClient();
  const input = { filter: address.filter, ...(address.cursor ? { cursor: address.cursor } : {}) };
  const queryKey = useMemo(() => ['loans-current', subject, address, lifetime] as const, [subject, address, lifetime]);
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      const current = origin.capture();
      if (!current()) throw new CancelledError({ silent: true, revert: true });
      try {
        const value = await readLoansCurrent({ data: input });
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        if (!matches(value, subject, address)) throw new Error('Unaccepted Loans read');
        return value;
      } catch (error) {
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
    },
    initialData,
    staleTime: Infinity,
    refetchOnMount: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [loader, setLoader] = useState(initial);
  if (loader !== initial) {
    setLoader(initial);
    if (!matches(initial, subject, address)) origin.rejectRead();
  }
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (!origin.isCurrent()) return;
    if (matches(initial, subject, address)) queryClient.setQueryData(queryKey, initial);
    else void query.refetch();
  }, [address, initial, origin, query.refetch, queryClient, queryKey, subject]);
  const accepted = !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  const page = accepted?.page;
  const guard = accepted
    ? origin.accept(queryKey, (value) => matches(value as LoansCurrentRead, subject, address), operations)
    : null;
  const operand: LoansOrigin | undefined = guard ? { isCurrent: guard.isCurrent, headers: guard.headers } : undefined;
  if (!page || (hydrated && !guard))
    return (
      <div>
        <p role="status">{query.isError || query.data ? m.error_message() : m.library_sort_preparing()}</p>
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
    <LoansPage
      key={origin.id}
      page={page}
      address={address}
      originating={operand ?? closed}
      onRefresh={() => {
        if (origin.isCurrent()) void query.refetch();
      }}
    />
  );
}
