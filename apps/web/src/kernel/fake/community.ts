import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';
import type { KernelClient } from '@rezics/client';
import type { RealmAppearanceSnapshot, RealmPresentationImage } from '../../community/realm-presentation';
import { fromPlainText, serializeDocument } from '@rezics/document';
import realm from '../recorded/realm.json';
import space from '../recorded/space.json';

// Keep the appearance fixture separate from the other community page scenarios.
export const appearanceRealmId = '01a1a100-0000-7000-8000-000000000002';
export const appearanceSpaceId = '01a1a100-0000-7000-8000-000000000001';
export const appearanceAddress = 'quiet-novel-club-appearance';
export const appearancePath = `/spaces/${appearanceAddress}`;
// This session credential represents the fixture's recorded Realm owner.
const ownerCredential = 'Bearer recorded-story-token';
type NativeRealm = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['realms']>['get']>>['data']>['realm'];

export const imageId = '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0001';
export const revisionId = '01a1a000-0000-7000-8000-000000000014';
// Explicit native DTO fixtures. No runtime source, authority, count or image availability is inferred.
export const image: RealmPresentationImage = {
  id: imageId,
  containerId: appearanceRealmId,
  digest: 'a'.repeat(64),
  width: 320,
  height: 480,
  variants: [{ format: 'webp', width: 320, height: 480 }],
  placeholder: null,
  focalPoint: null,
  credit: null,
};
export const bannerImage = { ...image, id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0003' };
export const configured: RealmAppearanceSnapshot = {
  realmId: appearanceRealmId,
  head: realm.realm.headRevisionId,
  title: realm.realm.title,
  contextId: realm.realm.contextId,
  state: 'active',
  canManage: true,
  presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
  avatar: { state: 'none', value: null },
  banner: { state: 'none', value: null },
  rules: { state: 'none', value: null },
};
export const available: RealmAppearanceSnapshot = {
  ...configured,
  presentation: { avatarMediaId: image.id, bannerMediaId: bannerImage.id, rules: { postId: imageId, revisionId } },
  avatar: { state: 'available', value: image },
  banner: { state: 'available', value: bannerImage },
  rules: {
    state: 'available',
    value: {
      postId: imageId,
      revisionId,
      title: 'A thoughtful reading room',
      summary: 'Discuss the work, respect other readers, and mark spoilers.',
    },
  },
};

/** Explicit native read fixtures shared by the page host and isolated source Pattern. */
export async function appearanceRecording(
  request: Request,
  snapshot = available,
): Promise<KernelRecording | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method === 'POST' && path === '/v1/viewerActions') {
    const body = (await request.json()) as { resources: { type: string; id: string }[] };
    if (!body.resources.every((resource) => resource.type === 'community.realm' && resource.id === snapshot.realmId))
      return;
    return {
      status: 200,
      resources: body.resources.map((resource) => ({
        ...resource,
        viewerActions:
          request.headers.get('authorization') === ownerCredential
            ? [{ action: 'realm:manage', operations: ['realm.update'] }]
            : [],
      })),
    };
  }
  if (request.method !== 'GET') return;
  if (path === `/v1/spaceAddresses/${appearanceAddress}`)
    return { status: 200, address: appearanceAddress, spaceId: appearanceSpaceId };
  if (path === `/v1/realms/${snapshot.realmId}`)
    return {
      status: 200,
      realm: {
        ...realm.realm,
        state: 'active',
        visibility: 'public',
        realmId: snapshot.realmId,
        spaceId: appearanceSpaceId,
        title: snapshot.title,
        contextId: snapshot.contextId,
        presentation: snapshot.presentation,
        headRevisionId: snapshot.head,
        ownershipState: 'owned',
        orphanedAt: null,
        claimEligibleAt: null,
        governanceReadOnly: false,
      } satisfies NativeRealm,
    };
  if (path === `/v1/realms/${snapshot.realmId}/participation`)
    return request.headers.get('authorization') === ownerCredential
      ? { status: 204 }
      : { status: 403, code: 'forbidden' };
  if (path === `/v1/realms/${snapshot.realmId}/boards` || path === `/v1/realms/${snapshot.realmId}/publications`)
    return { status: 200, items: [], next: null };
  const presentation = path === `/v1/realms/${snapshot.realmId}/presentation`;
  if (!presentation && path !== `/v1/spaces/${appearanceSpaceId}`) return;
  const body = fromPlainText(
    snapshot.rules.state === 'available' ? `${snapshot.rules.value.title}\n${snapshot.rules.value.summary}` : '',
  );
  const bytes = new TextEncoder().encode(serializeDocument(body));
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const home = {
    status: 200,
    space: { ...space.space, spaceId: appearanceSpaceId, realmId: snapshot.realmId, address: appearanceAddress },
    community: {
      realmId: snapshot.realmId,
      spaceId: appearanceSpaceId,
      contextId: snapshot.contextId,
      name: snapshot.title,
      description: realm.realm.summary,
      avatar: snapshot.avatar,
      banner: snapshot.banner,
      rules:
        snapshot.rules.state === 'available'
          ? {
              state: 'available',
              value: { ...snapshot.presentation.rules, body, licence: 'CC-BY-4.0', sha256 },
            }
          : snapshot.rules,
      members: { state: 'unknown', count: null, version: null },
      join: { membership: 'unknown', action: null },
    },
  };
  return presentation ? { status: 200, community: home.community } : home;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/(spaceAddresses|spaces|realms)\//,
    story: ({ request }) => appearanceRecording(request),
  },
  { method: 'POST', path: '/v1/viewerActions', story: ({ request }) => appearanceRecording(request) },
];
