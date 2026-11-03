import type { KernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';
import type { ReadCredentialMode } from '../kernel/credential';
import { boardCommunitySource, type CommunityPresentation } from '../threads/board-community-source';
import { realmClaimSnapshot } from './realm-claim';
import { readCommunity, type PublishedSubject, type RealmBoard, type ShelfPage, type SpacePageData } from './space';

type RealmRoute = ReturnType<KernelClient['realms']>;
type Realm = NonNullable<Awaited<ReturnType<RealmRoute['get']>>['data']>['realm'];
type Space = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['spaces']>['get']>>['data']>['space'];
type Result<T> = { status: number; data?: T | null; error?: unknown };
type Window<T> = { items: readonly T[]; next: string | null };

/** The mounted producer's current protocol, pending its generated Client declaration.
 * It deliberately cannot represent member standing or permitted commands yet. */
export type NativeRealmHomePage = {
  realm: Realm;
  space: Space;
  presentation: Omit<CommunityPresentation, 'join'>;
  boards: NativeRealmBoardPage;
  publications: NativeRealmPublicationPage;
  viewer: { state: 'anonymous' | 'unavailable' };
  actions: Readonly<Record<'participate' | 'join' | 'leave' | 'claim' | 'manage', 'sign-in' | 'unavailable'>>;
};
export type NativeRealmBoardPage = Window<{
  id: string;
  realmId: string | null;
  title: string | null;
  purpose: RealmBoard['purpose'];
  visibility: RealmBoard['visibility'];
  availability: 'available' | 'erased';
}>;
export type NativeRealmPublicationPage = Window<{
  publication: { realmId: string; subjectId: string; publicationId: string };
  summary: {
    id: string;
    type: string;
    types: string[];
    label: { value: string; language: string } | null;
    cover: CoverSummary | null;
  };
}>;

/** Prepared operations belong to one reader. No legacy get, membership, Subject or refill operation is admitted. */
export type NativeRealmHomeOperations = {
  home(input: { realmId: string; languages: string[] }): Promise<Result<NativeRealmHomePage>>;
  boardShelf(input: { realmId: string; cursor?: string }): Promise<Result<NativeRealmBoardPage>>;
  publicationShelf(input: {
    realmId: string;
    languages: string[];
    cursor?: string;
  }): Promise<Result<NativeRealmPublicationPage>>;
};

function boards(page: NativeRealmBoardPage, realmId: string): RealmBoard[] {
  if (page.items.length > 20 || page.items.some((item) => item.realmId !== realmId))
    throw new Error('Realm home board source changed');
  return page.items.flatMap((item) =>
    item.availability === 'available' && item.visibility !== 'taken_down'
      ? [{ id: item.id, title: item.title, purpose: item.purpose, visibility: item.visibility }]
      : [],
  );
}

function publications(page: NativeRealmPublicationPage, realmId: string): PublishedSubject[] {
  if (
    page.items.length > 12 ||
    page.items.some(
      ({ publication, summary }) => publication.realmId !== realmId || publication.subjectId !== summary.id,
    )
  )
    throw new Error('Realm home publication source changed');
  return page.items.map(({ publication, summary }) => ({
    id: summary.id,
    publicationId: publication.publicationId,
    types: summary.types.length ? summary.types : [summary.type],
    labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
    label: summary.label?.value ?? null,
    cover: summary.cover,
  }));
}

/** One mounted home response, without attempting to upgrade its unavailable viewer observation. */
export async function readNativeRealmHome(
  operations: NativeRealmHomeOperations,
  input: { realmId: string; spaceId: string; languages: string[]; credentialMode: ReadCredentialMode },
): Promise<SpacePageData> {
  const page = readCommunity(await operations.home({ realmId: input.realmId, languages: input.languages }));
  if (
    page.realm.state !== 'active' ||
    page.realm.realmId !== input.realmId ||
    page.realm.spaceId !== input.spaceId ||
    page.space.spaceId !== input.spaceId ||
    page.space.realmId !== input.realmId ||
    page.space.state !== 'active' ||
    page.presentation.realmId !== input.realmId ||
    page.presentation.spaceId !== input.spaceId ||
    page.presentation.contextId !== page.realm.contextId ||
    page.presentation.name !== page.realm.title ||
    page.presentation.description !== page.realm.summary ||
    !['anonymous', 'unavailable'].includes(page.viewer.state) ||
    (['participate', 'join', 'leave', 'claim', 'manage'] as const).some(
      (action) => page.actions[action] !== (page.viewer.state === 'anonymous' ? 'sign-in' : 'unavailable'),
    )
  )
    throw new Error('Realm home source changed');
  const presentation = boardCommunitySource({
    realmId: input.realmId,
    ...{ community: { ...page.presentation, join: { membership: 'unknown', action: null } } },
  });
  return {
    space: { id: page.space.spaceId, title: page.space.title, summary: page.space.summary },
    realm: {
      id: page.realm.realmId,
      title: page.realm.title,
      summary: page.realm.summary,
      visibility: page.realm.visibility,
      continuity: realmClaimSnapshot(page.realm),
      presentation: presentation ?? { state: 'unavailable', value: null },
      boards: boards(page.boards, input.realmId),
      published: publications(page.publications, input.realmId),
      boardNext: page.boards.next,
      publicationNext: page.publications.next,
      credentialMode: input.credentialMode,
      viewer: null,
      nativeObservation: { viewer: page.viewer, actions: page.actions },
    },
  };
}

function failure(result: Result<unknown>): ShelfPage<never> | null {
  if (result.status === 400 || result.status === 409) return { kind: 'stale' };
  if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
  if (result.error || result.status !== 200 || !result.data) return { kind: 'unavailable' };
  return null;
}

/** Each continuation retains its exact cursor; a sparse native page is never refilled. */
export function nativeRealmHomeShelves(
  operations: NativeRealmHomeOperations,
  source: { realmId: string; languages: string[] },
) {
  return {
    async boards(input: { cursor?: string }): Promise<ShelfPage<RealmBoard>> {
      try {
        const result = await operations.boardShelf({ realmId: source.realmId, ...input });
        return (
          failure(result) ?? {
            kind: 'page',
            items: boards(readCommunity(result), source.realmId),
            next: result.data!.next,
            unavailable: 0,
          }
        );
      } catch {
        return { kind: 'unavailable' };
      }
    },
    async publications(input: { cursor?: string }): Promise<ShelfPage<PublishedSubject>> {
      try {
        const result = await operations.publicationShelf({ ...source, ...input });
        return (
          failure(result) ?? {
            kind: 'page',
            items: publications(readCommunity(result), source.realmId),
            next: result.data!.next,
            unavailable: 0,
          }
        );
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
