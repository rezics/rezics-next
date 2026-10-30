import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { LIBRARY_PAGE_LIMIT, libraryListQuery, readLibraryResult, StaleCursorError } from './reads';
import type { LibraryAccount, CollectionVisibility } from './reads';

type CollectionRead = NonNullable<Awaited<ReturnType<KernelClient['collections']['get']>>['data']>;
type RawCollection = CollectionRead['collections'][number];

export type MineCollection = {
  id: string;
  title: string | null;
  membershipKind?: 'curated' | 'dynamic';
  builtinKind?: string;
  builtinLabels?: Record<string, string>;
  visibility?: CollectionVisibility;
  memberCount?: number;
  updatedAt?: string;
  curator: LibraryAccount | null;
};

export type MineCollectionsPage = {
  signedIn: boolean;
  collections: MineCollection[];
  navigationCollections?: MineCollection[];
  next: string | null;
};

async function readPage(
  client: KernelClient,
  accountId: string,
  authorization: string,
  cursor?: string,
): Promise<CollectionRead> {
  const result = await client.collections.get({
    query: { ...libraryListQuery(cursor, LIBRARY_PAGE_LIMIT), curatorAccountId: accountId },
    headers: { authorization },
  });
  return readLibraryResult(result);
}

function present(collection: RawCollection): MineCollection {
  const raw = collection as unknown as Record<string, unknown>;
  const dynamic = collection as unknown as {
    title?: string | null;
    membershipKind?: 'curated' | 'dynamic';
    builtinKind?: string;
    builtinLabels?: Record<string, string>;
  };
  const visibility = raw.visibility;
  const memberCount = raw.memberCount;
  const updatedAt = raw.updatedAt;
  return {
    id: collection.id,
    title: dynamic.title === undefined ? (collection.title ?? null) : dynamic.title,
    ...(dynamic.membershipKind ? { membershipKind: dynamic.membershipKind } : {}),
    ...(dynamic.builtinKind ? { builtinKind: dynamic.builtinKind } : {}),
    ...(dynamic.builtinLabels ? { builtinLabels: dynamic.builtinLabels } : {}),
    ...(visibility === 'private' || visibility === 'unlisted' || visibility === 'public' ? { visibility } : {}),
    ...(typeof memberCount === 'number' ? { memberCount } : {}),
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    curator: collection.curator
      ? { handle: collection.curator.handle, displayName: collection.curator.displayName }
      : null,
  };
}

/** Reads the first page for an already authenticated owner without resolving the session a second time. */
export async function loadMineCollectionsForOwner(
  client: KernelClient,
  accountId: string,
  authorization: string,
): Promise<MineCollectionsPage> {
  const page = await readPage(client, accountId, authorization);
  return { signedIn: true, collections: page.collections.map(present), next: page.next };
}

/** Reads one signed-in person's collection page, including private and unlisted records. */
export async function loadMineCollectionsPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<MineCollectionsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, collections: [], next: null };

  let page: CollectionRead;
  let navigationPage: CollectionRead | undefined;
  try {
    page = await readPage(client, accountId, authorization, input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await readPage(client, accountId, authorization);
    navigationPage = page;
  }
  if (!input.cursor) navigationPage = page;
  if (!navigationPage) navigationPage = await readPage(client, accountId, authorization);
  return {
    signedIn: true,
    collections: page.collections.map(present),
    navigationCollections: navigationPage.collections.map(present),
    next: page.next,
  };
}
