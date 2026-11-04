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

/** Local view of the documented mounted DTO while the shared client route declaration is pending. */
export type NativeRealmHomePage = {
  realm: Realm;
  space: Space;
  presentation: Omit<CommunityPresentation, 'join'>;
  boards: NativeRealmBoardPage;
  publications: NativeRealmPublicationPage;
  viewer:
    | { state: 'anonymous' }
    | {
        readability: 'allowed';
        membership:
          | { state: 'member'; since: string; reservationId: string; transactionId: string }
          | { state: 'none'; since: null; reservationId: null; transactionId: null };
        participation: 'allowed' | 'denied';
      };
  actions:
    | { state: 'sign-in' }
    | {
        state: 'current';
        enter: NativeRealmHomeAction;
        manage: NativeRealmHomeAction;
        leave: NativeRealmHomeAction;
      };
};
type NativeRealmHomeAction =
  | { state: 'available'; method: 'GET' | 'DELETE'; path: string; body: null; expectedStatus: 200 | 202 }
  | {
      state: 'prohibited';
      reason: 'not_authorized' | 'not_member' | 'signed_out' | 'governance_read_only';
    }
  | { state: 'unavailable'; reason: 'owner_invariant_observation_unavailable' };
export type NativeRealmHomeObservation = {
  viewer:
    | { state: 'anonymous' }
    | { state: 'member'; membership: 'none' | 'pending' | 'member' }
    | { state: 'denied' | 'banned' | 'orphaned' | 'unavailable' };
  actions: Readonly<
    Record<
      'participate' | 'join' | 'leave' | 'claim' | 'manage',
      'sign-in' | 'offered' | 'admitted' | 'denied' | 'banned' | 'orphaned' | 'unavailable'
    >
  >;
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

export type NativeRealmHomeOperations = {
  home(input: { realmId: string; languages: string[] }): Promise<Result<NativeRealmHomePage>>;
  boardShelf(input: { realmId: string; cursor?: string }): Promise<Result<NativeRealmBoardPage>>;
  publicationShelf(input: {
    realmId: string;
    languages: string[];
    cursor?: string;
  }): Promise<Result<NativeRealmPublicationPage>>;
};

/** Keep receiving unavailable until the installed client exposes its root-derived Realm Home routes. */
export function bindNativeRealmHomeOperations(
  _client: KernelClient,
  _auth: Record<string, never> | { headers: { authorization: string } },
): NativeRealmHomeOperations {
  const unavailable = async (): Promise<Result<never>> => ({
    status: 503,
    error: new Error('Installed Realm Home client contract is unavailable'),
  });
  return {
    home: unavailable,
    boardShelf: unavailable,
    publicationShelf: unavailable,
  };
}

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

type CurrentRealmHomeActions = Extract<NativeRealmHomePage['actions'], { state: 'current' }>;
type NativeAdviceState = NativeRealmHomeObservation['actions']['leave'];

function actionState(advice: CurrentRealmHomeActions['leave']): NativeAdviceState {
  if (advice.state === 'available') return 'admitted';
  if (advice.state === 'unavailable') return 'unavailable';
  if (advice.reason === 'signed_out') return 'sign-in';
  if (advice.reason === 'governance_read_only') return 'orphaned';
  return 'denied';
}

function availableActionMatches(
  advice: CurrentRealmHomeActions['enter'],
  method: 'GET' | 'DELETE',
  path: string,
  expectedStatus: 200 | 202,
) {
  return (
    advice.state !== 'available' ||
    (advice.method === method &&
      advice.path === path &&
      advice.body === null &&
      advice.expectedStatus === expectedStatus)
  );
}

function nativeObservation(page: NativeRealmHomePage): NativeRealmHomeObservation {
  if ('state' in page.viewer) {
    if (page.actions.state !== 'sign-in') throw new Error('Realm home viewer changed');
    return {
      viewer: { state: 'anonymous' },
      actions: { participate: 'sign-in', join: 'sign-in', leave: 'sign-in', claim: 'sign-in', manage: 'sign-in' },
    };
  }
  if (page.actions.state !== 'current') throw new Error('Realm home viewer changed');
  const { enter, manage, leave } = page.actions;
  if (
    !availableActionMatches(enter, 'GET', `/v1/realms/${page.realm.realmId}`, 200) ||
    !availableActionMatches(manage, 'GET', `/v1/realms/${page.realm.realmId}/settings`, 200) ||
    !availableActionMatches(leave, 'DELETE', `/v1/realms/${page.realm.realmId}/membership`, 202)
  )
    throw new Error('Realm home action source changed');
  const member = page.viewer.membership.state === 'member';
  const participate = page.viewer.participation === 'allowed' ? 'admitted' : 'denied';
  return {
    viewer: { state: 'member', membership: member ? 'member' : 'none' },
    actions: {
      participate,
      join: 'unavailable',
      leave: actionState(leave),
      claim: page.realm.ownershipState === 'orphaned' ? 'admitted' : 'unavailable',
      manage: actionState(manage),
    },
  };
}

/** Validates the single composed observation before mapping its native shelves and viewer advice. */
export function presentNativeRealmHome(
  page: NativeRealmHomePage,
  input: {
    realmId: string;
    spaceId: string;
    languages: string[];
    credentialMode: ReadCredentialMode;
    expectedSpaceHeadRevisionId?: string;
    expectedRealmHeadRevisionId?: string;
    banner?: CoverSummary | null;
  },
): SpacePageData {
  const observation = nativeObservation(page);
  const continuity = realmClaimSnapshot(page.realm);
  const selected = page.realm.presentation;
  if (
    !continuity ||
    !selected ||
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
    (input.expectedSpaceHeadRevisionId !== undefined &&
      page.space.headRevisionId !== input.expectedSpaceHeadRevisionId) ||
    (input.expectedRealmHeadRevisionId !== undefined && page.realm.headRevisionId !== input.expectedRealmHeadRevisionId)
  )
    throw new Error('Realm home source changed');
  for (const [image, mediaId] of [
    [page.presentation.avatar, selected.avatarMediaId],
    [page.presentation.banner, selected.bannerMediaId],
  ] as const) {
    if (image.state === 'available' && image.value.id !== mediaId) throw new Error('Realm home presentation changed');
  }
  const rules = page.presentation.rules;
  if (
    rules.state === 'available' &&
    (rules.value.postId !== selected.rules?.postId || rules.value.revisionId !== selected.rules?.revisionId)
  )
    throw new Error('Realm home presentation changed');
  const presentation = boardCommunitySource({
    realmId: input.realmId,
    ...{ community: { ...page.presentation, join: { membership: 'unknown', action: null } } },
  });
  return {
    space: {
      id: page.space.spaceId,
      title: page.space.title,
      summary: page.space.summary,
      ...(input.banner ? { banner: input.banner } : {}),
    },
    realm: {
      id: page.realm.realmId,
      title: page.realm.title,
      summary: page.realm.summary,
      visibility: page.realm.visibility,
      continuity,
      presentation: presentation ?? { state: 'unavailable', value: null },
      boards: boards(page.boards, input.realmId),
      published: publications(page.publications, input.realmId),
      boardNext: page.boards.next,
      publicationNext: page.publications.next,
      credentialMode: input.credentialMode,
      viewer: null,
      nativeObservation: observation,
      nativeSource: {
        realm: { headRevisionId: page.realm.headRevisionId, presentation: selected },
        space: { headRevisionId: page.space.headRevisionId },
      },
    },
  };
}

/** One mounted home response, without upgrading its viewer advice from another read. */
export async function readNativeRealmHome(
  operations: NativeRealmHomeOperations,
  input: {
    realmId: string;
    spaceId: string;
    languages: string[];
    credentialMode: ReadCredentialMode;
    expectedSpaceHeadRevisionId?: string;
    expectedRealmHeadRevisionId?: string;
    banner?: CoverSummary | null;
  },
): Promise<SpacePageData> {
  const page = readCommunity(await operations.home({ realmId: input.realmId, languages: input.languages }));
  return presentNativeRealmHome(page, input);
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
