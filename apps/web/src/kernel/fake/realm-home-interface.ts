import type { NativeRealmHomePage } from '../../community/realm-home-native';
import type { MyRealmsNativePage } from '../../community/my-realms-current/contract';
import type { FakeRoute } from '../fake-modules';
import { image, bannerImage } from './community';

// Deliberately synthetic installed-contract responses for the actual route stories.
// These supply no native producer, workflow or browser verification evidence.
const id = (suffix: number) => `01a1a800-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
export const interfaceRealmId = id(2);
export const interfaceSpaceId = id(1);
export const interfaceSpaceTitle = 'The Evening Reading Room';
export const interfaceRealmTitle = 'Readers Across Languages';
export const interfaceGlobalTitle = 'The Open Reading Space';
export const interfaceThreadTitle = 'Which translation stayed with you?';
export const interfaceCursors = {
  member: 'community-interface.member',
  withheld: 'community-interface.withheld',
  sparse: 'community-interface.sparse',
  next: 'community-interface.next',
} as const;
const createdAt = '2026-11-01T18:00:00.000Z';
const metadata = {
  state: 'active' as const,
  headRevisionId: id(3),
  createdAt,
  creator: id(4),
  predecessor: null,
  revisionCreatedAt: createdAt,
  author: id(4),
};
const membership = {
  state: 'member' as const,
  since: createdAt,
  reservationId: id(5),
  transactionId: id(6),
};
const avatar = { state: 'available' as const, value: { ...image, containerId: interfaceRealmId } };
const banner = { state: 'available' as const, value: { ...bannerImage, containerId: interfaceRealmId } };
const description = 'Read slowly, compare translations, and make room for another interpretation.';

export function interfaceRealmHome(signedIn: boolean): NativeRealmHomePage {
  return {
    realm: {
      ...metadata,
      realmId: interfaceRealmId,
      spaceId: interfaceSpaceId,
      contextId: id(7),
      boardSchemeId: null,
      visibility: 'public',
      title: interfaceRealmTitle,
      summary: description,
      ownershipState: 'owned',
      orphanedAt: null,
      claimEligibleAt: null,
      governanceReadOnly: false,
      votes: {},
      presentation: { avatarMediaId: image.id, bannerMediaId: bannerImage.id, rules: null },
    },
    space: {
      ...metadata,
      spaceId: interfaceSpaceId,
      realmId: interfaceRealmId,
      address: 'readers-realm',
      title: interfaceSpaceTitle,
      summary: 'A shared place for reading notes, thoughtful reviews, and conversations across languages.',
    },
    presentation: {
      realmId: interfaceRealmId,
      spaceId: interfaceSpaceId,
      contextId: id(7),
      name: interfaceRealmTitle,
      description,
      avatar,
      banner,
      rules: { state: 'none', value: null },
      members: { state: 'unknown', count: null, version: null },
    },
    boards: {
      items: [
        {
          id: id(11),
          realmId: interfaceRealmId,
          route: 1,
          visibility: 'published',
          securityRevision: '1',
          createdAt,
          title: 'Reading together',
          purpose: 'discussion',
          availability: 'available',
          recent: {
            state: 'current',
            complete: true,
            threads: [
              {
                thread: { id: id(12), title: interfaceThreadTitle },
                target: { kind: 'thread', id: id(12), boardId: id(11) },
                comments: {
                  state: 'current',
                  cohort: 'public',
                  count: { kind: 'exact', value: 8 },
                  lastActivityAt: createdAt,
                  source: { epoch: 1, position: '8' },
                },
              },
            ],
          },
        },
        {
          id: id(13),
          realmId: interfaceRealmId,
          route: 1,
          visibility: 'published',
          securityRevision: '1',
          createdAt,
          title: 'Reviews and rereads',
          purpose: 'reviews',
          availability: 'available',
          recent: { state: 'current', complete: true, threads: [] },
        },
      ],
      next: null,
    },
    publications: {
      items: [
        {
          publication: {
            realmId: interfaceRealmId,
            subjectId: id(21),
            publicationId: id(22),
            verdict: 'adopt',
            subjectRevisionId: null,
            publishedAt: createdAt,
          },
          summary: {
            id: id(21),
            type: 'schema:Book',
            types: ['schema:Book'],
            creativeWork: true,
            label: { language: 'en', value: 'A book to read together' },
            cover: null,
          },
        },
      ],
      next: null,
    },
    viewer: signedIn ? { readability: 'allowed', membership, participation: 'allowed' } : { state: 'anonymous' },
    actions: signedIn
      ? {
          state: 'current',
          enter: {
            state: 'available',
            method: 'GET',
            path: `/v1/realms/${interfaceRealmId}`,
            body: null,
            expectedStatus: 200,
          },
          manage: { state: 'prohibited', reason: 'not_authorized' },
          leave: {
            state: 'available',
            method: 'DELETE',
            path: `/v1/realms/${interfaceRealmId}/membership`,
            body: null,
            expectedStatus: 202,
          },
        }
      : { state: 'sign-in' },
  };
}

/** Only named opaque fixture coordinates change the supplied inventory page. */
export function interfaceInventory(cursor: string | null): MyRealmsNativePage | undefined {
  if (cursor === interfaceCursors.sparse) return { items: [], next: interfaceCursors.next };
  if (cursor !== interfaceCursors.member && cursor !== interfaceCursors.withheld && cursor !== interfaceCursors.next)
    return;
  const actions: MyRealmsNativePage['items'][number]['current']['actions'] = {
    state: 'current',
    enter:
      cursor === interfaceCursors.withheld
        ? { state: 'prohibited', reason: 'not_authorized' }
        : {
            state: 'available',
            method: 'GET',
            path: `/v1/realms/${interfaceRealmId}`,
            body: null,
            expectedStatus: 200,
          },
    manage:
      cursor === interfaceCursors.withheld
        ? { state: 'prohibited', reason: 'not_authorized' }
        : {
            state: 'available',
            method: 'GET',
            path: `/v1/realms/${interfaceRealmId}/members`,
            body: null,
            expectedStatus: 200,
          },
    leave: {
      state: 'available',
      method: 'DELETE',
      path: `/v1/realms/${interfaceRealmId}/membership`,
      body: null,
      expectedStatus: 202,
    },
  };
  return {
    items: [
      {
        realmId: interfaceRealmId,
        name: interfaceRealmTitle,
        role: 'member',
        current: {
          description,
          avatar,
          banner,
          destination: { kind: 'realm', realmId: interfaceRealmId },
          spaceId: interfaceSpaceId,
          viewer: { readability: 'allowed', membership, participation: 'allowed' },
          actions,
        },
      },
    ],
    next: null,
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/spaceAddresses\/(readers-realm|readers-global)$/,
    story: ({ match }) => ({ status: 200, spaceId: match?.[1] === 'readers-global' ? id(31) : interfaceSpaceId }),
  },
  {
    method: 'GET',
    path: `/v1/spaces/${interfaceSpaceId}`,
    story: () => ({ status: 200, space: interfaceRealmHome(false).space }),
  },
  {
    method: 'GET',
    path: `/v1/spaces/${id(31)}`,
    story: () => ({
      status: 200,
      space: {
        ...metadata,
        spaceId: id(31),
        realmId: null,
        address: 'readers-global',
        title: interfaceGlobalTitle,
        summary: 'An open meeting place for readers. This Space has no Realm catalogue or discussion boards attached.',
      },
    }),
  },
  {
    method: 'GET',
    path: `/v1/realms/${interfaceRealmId}`,
    story: () => ({ status: 200, realm: interfaceRealmHome(false).realm }),
  },
  {
    method: 'GET',
    path: `/v1/realms/${interfaceRealmId}/home`,
    story: ({ request }) => ({ status: 200, ...interfaceRealmHome(request.headers.has('authorization')) }),
  },
  {
    method: 'GET',
    path: `/v1/realms/${interfaceRealmId}/boardShelf`,
    story: () => ({ status: 200, ...interfaceRealmHome(false).boards }),
  },
  {
    method: 'GET',
    path: `/v1/realms/${interfaceRealmId}/publicationShelf`,
    story: () => ({ status: 200, ...interfaceRealmHome(false).publications }),
  },
];
