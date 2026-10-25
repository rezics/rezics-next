import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { LIBRARY_PAGE_LIMIT, libraryListQuery, readLibraryResult, StaleCursorError } from './reads';
import type { LibraryAccount, CollectionVisibility } from './reads';

type CollectionRead = NonNullable<Awaited<ReturnType<KernelClient['collections']['get']>>['data']>;
type RawCollection = CollectionRead['collections'][number];

export type MineCollection = {
  id: string;
  title: string;
  visibility: CollectionVisibility;
  memberCount: number;
  updatedAt: string;
  curator: LibraryAccount | null;
};

export type MineCollectionsPage = {
  signedIn: boolean;
  collections: MineCollection[];
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
  return {
    id: collection.id,
    title: collection.title,
    visibility: collection.visibility,
    memberCount: collection.memberCount,
    updatedAt: collection.updatedAt,
    curator: collection.curator
      ? { handle: collection.curator.handle, displayName: collection.curator.displayName }
      : null,
  };
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
  try {
    page = await readPage(client, accountId, authorization, input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await readPage(client, accountId, authorization);
  }
  return { signedIn: true, collections: page.collections.map(present), next: page.next };
}
