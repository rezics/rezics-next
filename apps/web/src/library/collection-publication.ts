import { queryOptions } from '@tanstack/react-query';
import { isNotFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../session/client';
import { requestCsrfToken, sessionSubject } from '../session/request';
import { personalRead } from '../kernel/query';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { readCollectionPage } from './collection-queries';
import { collectionResultMatches, type CollectionPageResult } from './collection-load';
import type { DynamicCollectionPage } from './dynamic-collection';
import { asSession, isRecord, writeSession } from './collection-records';

export type PublicationViewer = { subject: string; csrfToken: string | null };
export type PublicationAddress = { id: string; cursor?: string };
export type PublicationInput = {
  collectionId: string;
  revision: number;
  subjectIds: string[];
  idempotencyKey: string;
};
export type PublicationComplete = {
  collection: { id: string; revision: number };
  publication: { generation: string; state: 'complete'; itemCount: number };
};
export type PublicationResult =
  | ({ ok: true } & PublicationComplete)
  | { ok: false; reason: 'denied' | 'stale' | 'unavailable' | 'unknown' | 'closed' };
export type PublicationPage = {
  viewer: PublicationViewer | null;
  address: PublicationAddress;
  source:
    | { state: 'ready'; page: DynamicCollectionPage; revision: number }
    | { state: 'denied' | 'unsupported' | 'unavailable' | 'preparing' };
};

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[^/?:#\s]{1,128}$/u.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function publicationAddress(input: unknown): PublicationAddress {
  if (
    !isRecord(input) ||
    !identifier(input.id) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096))
  )
    throw new Error('Invalid publication address');
  return { id: input.id, ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}) };
}

export function publicationInput(input: unknown): PublicationInput {
  if (
    !isRecord(input) ||
    !identifier(input.collectionId) ||
    !revision(input.revision) ||
    !Array.isArray(input.subjectIds) ||
    input.subjectIds.length > 100 ||
    !input.subjectIds.every(identifier) ||
    new Set(input.subjectIds).size !== input.subjectIds.length ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  )
    throw new Error('Invalid selected publication');
  return {
    collectionId: input.collectionId,
    revision: input.revision,
    subjectIds: [...input.subjectIds],
    idempotencyKey: input.idempotencyKey,
  };
}

/** FULL native summaries supply canonical IDs. Curated occurrence IDs never enter this selection. */
export function publicationCandidates(page: DynamicCollectionPage) {
  const seen = new Set<string>();
  return page.members.filter((member) => {
    const id = member.subject?.id;
    if (!identifier(member.subjectId) || !identifier(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function publicationSource(page: CollectionPageResult, owner: string): PublicationPage['source'] {
  if (!('preparing' in page) || page.builtinKind !== undefined) return { state: 'unsupported' };
  if (page.curatorAccountId !== owner) return { state: 'denied' };
  if (page.unavailable || page.filterStatus || !revision(page.revision)) return { state: 'unavailable' };
  if (page.preparing) return { state: 'preparing' };
  return {
    state: 'ready',
    page: { ...page, members: page.members.map((member) => ({ ...member, note: null })) },
    revision: page.revision,
  };
}

/** Exact declared native wire; replace with the generated client method when that module is generated. */
export const selectedPublicationRoute = (id: string) => `/v1/collections/${encodeURIComponent(id)}:publishSelected`;
export type SelectedPublicationAdapter = (
  input: PublicationInput,
  authorization: string,
) => Promise<{ status: number; body: unknown }>;

/** An absent runtime is unavailable. Development recordings never stand in for native publication. */
export function selectedPublicationAdapter(origin?: string, fetcher: typeof fetch = fetch): SelectedPublicationAdapter {
  return async (input, authorization) => {
    if (!origin) return { status: 503, body: null };
    const response = await fetcher(new URL(selectedPublicationRoute(input.collectionId), origin), {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ revision: input.revision, subjectIds: input.subjectIds }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

export function publicationResponse(status: number, body: unknown, input: PublicationInput): PublicationResult {
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 409) return { ok: false, reason: 'stale' };
  if ([400, 401, 403, 422].includes(status)) return { ok: false, reason: 'denied' };
  if ([404, 501, 503].includes(status)) return { ok: false, reason: 'unavailable' };
  if (
    status !== 200 ||
    !isRecord(body) ||
    !isRecord(body.collection) ||
    !isRecord(body.publication) ||
    body.collection.id !== input.collectionId ||
    body.collection.revision !== input.revision + 1 ||
    body.publication.state !== 'complete' ||
    !identifier(body.publication.generation) ||
    body.publication.itemCount !== input.subjectIds.length
  )
    return { ok: false, reason: 'unknown' };
  return {
    ok: true,
    collection: { id: body.collection.id, revision: body.collection.revision },
    publication: { generation: body.publication.generation, state: 'complete', itemCount: body.publication.itemCount },
  };
}

export async function publishSelectedRecord(
  adapter: SelectedPublicationAdapter,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: PublicationInput,
): Promise<PublicationResult> {
  const validated = publicationInput(input);
  const session = await writeSession(request, sessionEnv);
  if (!asSession(session)) return { ok: false, reason: session.reason === 'unavailable' ? 'unavailable' : 'denied' };
  try {
    const result = await adapter(validated, session.authorization);
    return publicationResponse(result.status, result.body, validated);
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unknown' };
  }
}

export const publishSelectedCollection = createServerFn({ method: 'POST' })
  .validator(publicationInput)
  .handler(async ({ data }): Promise<PublicationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    return publishSelectedRecord(
      selectedPublicationAdapter((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN),
      getRequest(),
      env as Partial<SessionEnv>,
      data,
    );
  });

export const readCollectionPublication = createServerFn({ method: 'GET' })
  .validator(publicationAddress)
  .handler(async ({ data }): Promise<PublicationPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN)
      return { viewer: null, address: data, source: { state: 'unavailable' } };
    const request = getRequest();
    return loadCollectionPublication(request, data, () =>
      readCollectionPage({
        data: { ...data, credentialMode: 'session', editor: true, filterActive: false },
      }),
    );
  });

/** Only the actual page reader prepares a session. Its provenance also binds empty/preparing pages. */
export async function loadCollectionPublication(
  request: Request,
  address: PublicationAddress,
  read: () => Promise<CollectionPageResult>,
): Promise<PublicationPage> {
  try {
    const page = await read();
    const subject = sessionSubject(request);
    const csrfToken = requestCsrfToken(request);
    if (!subject || !collectionResultMatches(page, { ...address, editor: true }, 'session', subject))
      return { viewer: null, address, source: { state: 'denied' } };
    return { viewer: { subject, csrfToken }, address, source: publicationSource(page, subject) };
  } catch (error) {
    return { viewer: null, address, source: { state: isNotFound(error) ? 'denied' : 'unavailable' } };
  }
}

/** No automatic retry, background refresh, SSR personal data, or cross-session result reuse. */
export function collectionPublicationQuery(
  viewer: PublicationViewer,
  address: PublicationAddress,
  isCurrent: () => boolean = () => true,
) {
  return queryOptions({
    ...personalRead,
    queryKey: ['collection-publication', viewer.subject, viewer.csrfToken, address.id, address.cursor ?? null],
    queryFn: async ({ signal }): Promise<PublicationPage> => {
      if (!isCurrent()) throw new Error('Retired publication read');
      const page = await readCollectionPublication({ data: address });
      if (!isCurrent()) throw new Error('Retired publication read');
      signal.throwIfAborted();
      if (
        page.viewer?.subject !== viewer.subject ||
        page.address.id !== address.id ||
        page.address.cursor !== address.cursor
      )
        return { viewer: null, address, source: { state: 'denied' } };
      return page;
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
