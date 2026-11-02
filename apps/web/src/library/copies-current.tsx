import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CancelledError, useQuery } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { CopiesPage, type CopiesOrigin } from './copies-page';
import { CopiesAddressRecovery } from './copies-address-recovery';
import type { CopiesQuery } from './copies-query';
import { useManagementCurrentOrigin } from './management-current-origin';
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
const closed: CopiesOrigin = {
  isCurrent: () => false,
  headers: () => null,
  readDetail: async () => ({ ok: false, reason: 'unavailable' }),
  readSubject: async () => ({ state: 'unavailable' }),
};
const operations = ['copy.list', 'copy.get', 'copy.create', 'copy.update', 'copy.delete'] as const;
function matches(value: CopiesCurrentRead | undefined, subject: string, address: CopiesAddress) {
  return (
    value?.sessionSubject === subject &&
    !!value.requested &&
    sameCopiesAddress(value.requested, address) &&
    value.page?.signedIn &&
    value.page.subjectId === address.subjectId &&
    (!address.subjectId || value.page.copies.every((copy) => !copy.subject || copy.subject.id === address.subjectId))
  );
}

export function CopiesCurrent({
  initial,
  search,
  locale,
  failure,
}: {
  initial: CopiesCurrentRead;
  search: CopiesQuery;
  locale: string;
  failure?: string | undefined;
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
  const address = copiesAddress(search, locale);
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
  if (address.issue)
    return <CopiesAddressRecovery key={origin.id} address={address} current={() => origin.isCurrent()} />;
  return (
    <>
      {!allowed ? <p role="status">{m.library_sort_preparing()}</p> : null}
      <div hidden={!allowed}>
        <CurrentCopiesRead
          key={origin.id}
          subject={subject}
          address={address}
          initial={initial}
          seed={scope.seed}
          hydrated={hydrated}
          origin={origin}
          failure={failure}
        />
      </div>
    </>
  );
}

function CurrentCopiesRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
  failure,
}: {
  subject: string;
  address: CopiesAddress;
  initial: CopiesCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: ReturnType<typeof useManagementCurrentOrigin>;
  failure?: string | undefined;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const input = { subjectId: address.subjectId ?? undefined, cursor: address.cursor ?? undefined };
  const queryKey = ['copies-current', subject, address, lifetime] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      const current = origin.capture();
      if (!current()) throw new CancelledError({ silent: true, revert: true });
      try {
        const value = await readCopiesCurrent({ data: input });
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        if (!matches(value, subject, address)) throw new Error('Unaccepted Copies read');
        return value;
      } catch (error) {
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
    },
    initialData,
    // The loader already performed the bounded read; retry remains explicit.
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
    if (origin.isCurrent()) void query.refetch();
  }, [initial, origin, query.refetch]);
  const accepted = !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  // Page provenance comes from the admitted envelope, never from rows or the next cursor.
  const page = useMemo(
    () => (accepted ? { ...accepted.page, requestedCursor: accepted.requested.cursor } : undefined),
    [accepted],
  );
  const guard = accepted
    ? origin.accept(queryKey, (value) => matches(value as CopiesCurrentRead, subject, address), operations)
    : null;
  const operand: CopiesOrigin | undefined = guard
    ? {
        isCurrent: guard.isCurrent,
        headers: guard.headers,
        readDetail: async (id) => {
          if (!guard.isCurrent('copy.get')) return { ok: false, reason: 'unavailable' };
          const value = await readCopyDetailCurrent({ data: { ...input, id } });
          if (!guard.isCurrent('copy.get')) return { ok: false, reason: 'unavailable' };
          if (
            value.sessionSubject !== subject ||
            !sameCopiesAddress(value.requested, address) ||
            value.id !== id ||
            (value.result.ok &&
              (value.result.copy.id !== id ||
                (address.subjectId && value.result.copy.subject && value.result.copy.subject.id !== address.subjectId)))
          ) {
            origin.rejectRead();
            return { ok: false, reason: 'unavailable' };
          }
          return value.result;
        },
        readSubject: async (id) => {
          if (!guard.isCurrent('copy.create')) return { state: 'unavailable' };
          const value = await readCopySubjectCurrent({ data: { ...input, id } });
          if (!guard.isCurrent('copy.create')) return { state: 'unavailable' };
          if (
            value.sessionSubject !== subject ||
            !sameCopiesAddress(value.requested, address) ||
            value.id !== id ||
            (value.result.state === 'ready' && value.result.subject.id !== id)
          ) {
            origin.rejectRead();
            return { state: 'unavailable' };
          }
          return value.result;
        },
      }
    : undefined;
  // Server HTML keeps the existing no-JS form; browser authority comes only from the cache guard.
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
  return <CopiesPage key={origin.id} page={page} failure={failure} originating={operand ?? closed} />;
}
