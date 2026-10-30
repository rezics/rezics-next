import { collectionPresentationOf, type CollectionPresentationData } from './collection-presentation';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { LIBRARY_PAGE_LIMIT, libraryLabel, libraryListQuery, readLibraryResult, StaleCursorError } from './reads';
import type { LibraryAccount, CollectionVisibility, LibrarySubject } from './reads';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { COLLECTION_PREVIEW_PAGE_LIMIT, type CollectionPreview } from './collection-preview';

type CollectionRead = NonNullable<Awaited<ReturnType<KernelClient['collections']['get']>>['data']>;
type RawCollection = CollectionRead['collections'][number];

/** Page presentation boundary; absent native preview data is never a ready empty preview. */
export type MineCollectionPreview =
  | { state: 'unavailable' }
  | { state: 'preparing' }
  | { state: 'loaded'; members: readonly LibrarySubject[]; emptyConfirmed?: true };

export type MineCollection = CollectionPresentationData & {
  id: string;
  title: string | null;
  membershipKind?: 'curated' | 'dynamic';
  builtinKind?: string;
  builtinLabels?: Record<string, string>;
  visibility?: CollectionVisibility;
  memberCount?: number;
  updatedAt?: string;
  curator: LibraryAccount | null;
  preview?: MineCollectionPreview;
};

export type MineCollectionsPage = {
  signedIn: boolean;
  collections: MineCollection[];
  navigationCollections?: MineCollection[];
  next: string | null;
  state?: 'loaded' | 'preparing' | 'denied' | 'unavailable' | 'error';
};

class MineCollectionsReadError extends Error {
  constructor(readonly state: 'preparing' | 'denied' | 'unavailable' | 'error') {
    super(state);
  }
}

async function readPage(
  client: KernelClient,
  accountId: string,
  authorization: string,
  cursor?: string,
  previews = false,
): Promise<CollectionRead> {
  const query: ReturnType<typeof libraryListQuery> & { curatorAccountId: string; preview?: 3 } = {
    ...libraryListQuery(cursor, previews ? COLLECTION_PREVIEW_PAGE_LIMIT : LIBRARY_PAGE_LIMIT),
    curatorAccountId: accountId,
    ...(previews ? { preview: 3 } : {}),
  };
  const result = await client.collections.get({
    query,
    headers: { authorization },
  });
  try {
    return readLibraryResult(result);
  } catch (error) {
    if (error instanceof StaleCursorError || isPlatformClosedError(error)) throw error;
    throw new MineCollectionsReadError(
      result.status === 202
        ? 'preparing'
        : result.status === 403
          ? 'denied'
          : result.status >= 500 && result.status !== 503
            ? 'error'
            : 'unavailable',
    );
  }
}

/** Missing native fields stay unavailable until the producer and generated client are integrated. */
function previewOf(collection: Partial<CollectionPreview>): MineCollectionPreview {
  if (collection.previewStatus === 'pending') return { state: 'preparing' };
  if (collection.previewStatus !== 'ready' || !collection.previewMembers) return { state: 'unavailable' };
  return {
    state: 'loaded',
    ...(collection.previewMembers.length === 0 ? { emptyConfirmed: true } : {}),
    members: collection.previewMembers.map(({ subject }) => ({
      id: subject.id,
      type: subject.type,
      types: subject.types,
      label: libraryLabel(subject.label, subject.id),
      ...(subject.label ? { labelLanguage: subject.label.language } : {}),
      cover: subject.cover,
    })),
  };
}

function present(collection: RawCollection & Partial<CollectionPreview>): MineCollection {
  const membershipKind = 'membershipKind' in collection ? collection.membershipKind : undefined;
  const builtinKind = 'builtinKind' in collection ? collection.builtinKind : undefined;
  const labels = 'builtinLabels' in collection ? collection.builtinLabels : undefined;
  const builtinLabels =
    labels && typeof labels === 'object'
      ? Object.fromEntries(
          Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : undefined;
  return {
    ...collectionPresentationOf(collection),
    id: collection.id,
    title: collection.title ?? null,
    ...(membershipKind === 'curated' || membershipKind === 'dynamic' ? { membershipKind } : {}),
    ...(typeof builtinKind === 'string' ? { builtinKind } : {}),
    ...(builtinLabels ? { builtinLabels } : {}),
    visibility: collection.visibility,
    memberCount: collection.memberCount,
    updatedAt: collection.updatedAt,
    preview: previewOf(collection),
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
  input: { layout?: 'rows' | 'previews' } = {},
): Promise<MineCollectionsPage> {
  const page = await readPage(client, accountId, authorization, undefined, input.layout === 'previews');
  return { signedIn: true, collections: page.collections.map(present), next: page.next };
}

/** Reads one signed-in person's collection page, including private and unlisted records. */
export async function loadMineCollectionsPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string; layout?: 'rows' | 'previews' },
): Promise<MineCollectionsPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, collections: [], next: null };

  try {
    let page: CollectionRead;
    let navigationPage: CollectionRead | undefined;
    try {
      page = await readPage(client, accountId, authorization, input.cursor, input.layout === 'previews');
    } catch (error) {
      if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
      page = await readPage(client, accountId, authorization, undefined, input.layout === 'previews');
      navigationPage = page;
    }
    // Preview navigation shares the returned page's budget, including on later cursor pages.
    if (!input.cursor || input.layout === 'previews') navigationPage = page;
    if (!navigationPage) navigationPage = await readPage(client, accountId, authorization);
    return {
      signedIn: true,
      state: 'loaded',
      collections: page.collections.map(present),
      navigationCollections: navigationPage.collections.map(present),
      next: page.next,
    };
  } catch (error) {
    if (error instanceof MineCollectionsReadError)
      return { signedIn: true, state: error.state, collections: [], next: null };
    throw error;
  }
}
