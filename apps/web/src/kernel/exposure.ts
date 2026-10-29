import { queryOptions, useQuery, QueryClient, QueryClientContext } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { Fragment, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { exposureQuery, useSession } from '../session/query';

/** The site's gated operations. Controls name an operation; OpenAPI owns its group. */
export const operationGroups = {
  'account.collections': 'collections',
  'collection.list': 'collections',
  'collection.create': 'collections',
  'collection.delete': 'collections',
  'collection.get': 'collections',
  'collection.update': 'collections',
  'collection_member.list': 'collections',
  'collection_member.create': 'collections',
  'collection_member.delete': 'collections',
  'collection_member.update': 'collections',
  'collection_member.move': 'collections',
  'copy.list': 'personal_library',
  'copy.create': 'personal_library',
  'copy.delete': 'personal_library',
  'copy.get': 'personal_library',
  'copy.update': 'personal_library',
  'follow.list': 'personal_library',
  'follow.delete': 'personal_library',
  'follow.get': 'personal_library',
  'follow.put': 'personal_library',
  'library_entry.list': 'personal_library',
  'library_continue.list': 'library_continue.list',
  'library_entry.delete': 'personal_library',
  'library_entry.get': 'personal_library',
  'library_entry.put': 'personal_library',
  'library_shelf.summary': 'personal_library',
  'library_shelf.types': 'personal_library',
  'offer.get': 'purchases',
  'order.create': 'purchases',
  'order.get': 'purchases',
  'progress_session.list': 'reading_progress',
  'progress_session.create': 'reading_progress',
  'progress_session.read': 'reading_progress',
  'progress_session.changes': 'reading_progress',
  'progress_session.units': 'reading_progress',
  'progress_session.abandon': 'reading_progress',
  'progress_session.complete': 'reading_progress',
  'progress_session.record': 'reading_progress',
  'published_log.list': 'reading_progress',
  'published_log.create': 'reading_progress',
  'published_log.delete': 'reading_progress',
  'published_log.read': 'reading_progress',
  'subject_collection.list': 'collections',
} as const;
export type GatedOperation = keyof typeof operationGroups;

const minute = 60_000;
const closed: string[] = [];

/** Both in-flight and failed anonymous reads share the same one-minute isolate entry. */
let anonymous: { expires: number; pending: Promise<string[]> } | undefined;
export const readAdmitted = createServerOnlyFn(async (authorization?: string): Promise<string[]> => {
  const { kernelClient } = await import('./client');
  try {
    const result = await kernelClient().platform.exposure.get({
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { signal: AbortSignal.timeout(2_000) },
    });
    if (result.error || !Array.isArray(result.data?.admitted)) return closed;
    return result.data.admitted;
  } catch {
    return closed;
  }
});

async function anonymousAdmitted(): Promise<string[]> {
  const now = Date.now();
  if (!anonymous || now >= anonymous.expires) {
    anonymous = { expires: now + minute, pending: readAdmitted() };
  }
  return anonymous.pending;
}

const readAnonymousExposure = createServerFn({ method: 'GET' }).handler(anonymousAdmitted);

const anonymousQuery = queryOptions({
  queryKey: ['exposure', 'anonymous'],
  queryFn: () => readAnonymousExposure(),
  staleTime: minute,
  retry: false,
});

/** Public HTML never resolves a session, even if the document request carries its cookie. */
export const prepareExposure = createIsomorphicFn()
  .server(async (client: QueryClient) => {
    await client.ensureQueryData(anonymousQuery);
  })
  .client(() => undefined);

const subscribe = () => () => {};
// Standalone server-rendered previews have no query provider and remain closed.
const previewClient = new QueryClient();
export function useOperation(operation: GatedOperation): boolean {
  const client = useContext(QueryClientContext) ?? previewClient;
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { state } = useSession();
  const { data: publicGroups } = useQuery({ ...anonymousQuery, enabled: hydrated && state === 'signed-out' }, client);
  const { data: viewerGroups } = useQuery({ ...exposureQuery, enabled: hydrated && state === 'signed-in' }, client);
  const admitted =
    !hydrated || state === 'signed-out' ? publicGroups : state === 'signed-in' ? viewerGroups : undefined;
  return admitted?.includes(operationGroups[operation]) ?? false;
}

export function Exposure({ operation, children }: { operation: GatedOperation; children: ReactNode }) {
  return useOperation(operation) ? createElement(Fragment, null, children) : null;
}
