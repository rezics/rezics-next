import type {
  RealmAppearanceAdapter,
  RealmAppearanceSnapshot,
  RealmPresentationImage,
} from '../../../community/realm-presentation';
import realm from '../../../kernel/recorded/realm.json';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { readRealmAppearance } from '../../../community/realm-presentation-native';

export const imageId = '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d5e01';
export const revisionId = '01a1a000-0000-7000-8000-000000000014';
// Explicit native DTO fixtures. No runtime source, authority, count or image availability is inferred.
export const image: RealmPresentationImage = {
  id: imageId,
  containerId: realm.realm.realmId,
  digest: 'a'.repeat(64),
  width: 320,
  height: 480,
  variants: [{ format: 'webp', width: 320, height: 480 }],
  placeholder: null,
  focalPoint: null,
  credit: null,
};
export const bannerImage = { ...image, id: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d5e02' };
export const configured: RealmAppearanceSnapshot = {
  realmId: realm.realm.realmId,
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
export function fixtureAdapter(snapshot = configured): RealmAppearanceAdapter {
  return {
    read: async () => ({ kind: 'ready', snapshot }),
    change: async (command) => ({
      kind: 'confirmed',
      snapshot: {
        ...snapshot,
        presentation: command.presentation,
        head: revisionId,
        avatar: command.presentation.avatarMediaId
          ? { state: 'available', value: image }
          : { state: 'none', value: null },
        banner: command.presentation.bannerMediaId
          ? { state: 'available', value: bannerImage }
          : { state: 'none', value: null },
        rules: command.presentation.rules ? available.rules : { state: 'none', value: null },
      },
    }),
    select: async (choice) =>
      choice.kind === 'image'
        ? { kind: 'image', image: { ...(choice.purpose === 'realm-icon' ? image : bannerImage), id: choice.mediaId } }
        : {
            kind: 'rules',
            rules: {
              postId: choice.postId,
              revisionId: choice.revisionId,
              title: 'A thoughtful reading room',
              summary: 'Discuss the work, respect other readers, and mark spoilers.',
            },
          },
    upload: async (_realmId, slot) => ({ id: slot === 'avatar' ? imageId : bannerImage.id }),
    resume: async (id) => ({ id }),
  };
}

/** Fixed native HTTP responses exercise the same source adapter mounted in Space management.
 * These story fixtures establish no native authorization, processing or claim evidence. */
export async function readFixtureAppearance(snapshot = available) {
  const body = fromPlainText(
    `${available.rules.state === 'available' ? available.rules.value.title : ''}\n${available.rules.state === 'available' ? available.rules.value.summary : ''}`,
  );
  const bytes = new TextEncoder().encode(serializeDocument(body));
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const client = createKernelClient('https://kernel.story', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === `/v1/realms/${snapshot.realmId}`)
        return Response.json({
          realm: {
            ...realm.realm,
            presentation: snapshot.presentation,
            headRevisionId: snapshot.head,
            ownershipState: 'owned',
            governanceReadOnly: false,
          },
        });
      if (path === '/v1/viewerActions')
        return Response.json({
          resources: [
            {
              type: 'community.realm',
              id: snapshot.realmId,
              viewerActions: [{ action: 'realm:manage', operations: ['realm.update'] }],
            },
          ],
        });
      if (path === `/v1/spaces/${realm.realm.spaceId}`)
        return Response.json({
          space: { spaceId: realm.realm.spaceId, realmId: snapshot.realmId, state: 'active' },
          community: {
            realmId: snapshot.realmId,
            spaceId: realm.realm.spaceId,
            contextId: snapshot.contextId,
            name: snapshot.title,
            description: realm.realm.summary,
            avatar: snapshot.avatar,
            banner: snapshot.banner,
            rules:
              snapshot.rules.state === 'available'
                ? {
                    state: 'available',
                    value: {
                      postId: snapshot.rules.value.postId,
                      revisionId: snapshot.rules.value.revisionId,
                      body,
                      licence: 'CC-BY-4.0',
                      sha256,
                    },
                  }
                : snapshot.rules,
            members: { state: 'unknown', count: null, version: null },
            join: { membership: 'unknown', action: null },
          },
        });
      throw new Error(`Unexpected story request ${path}`);
    }) as typeof fetch,
  });
  return readRealmAppearance(client, 'Bearer story-manager', snapshot.realmId);
}
