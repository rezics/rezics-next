import type {
  RealmAppearanceAdapter,
  RealmAppearanceSnapshot,
  RealmPresentationImage,
} from '../../../community/realm-presentation';
import realm from '../../../kernel/recorded/realm.json';

export const imageId = '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d5e01';
export const revisionId = '01a1a000-0000-7000-8000-000000000014';
// Explicit future-producer fixtures. No runtime source, authority, count or image availability is inferred.
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
  presentation: { avatarMediaId: image.id, bannerMediaId: image.id, rules: { postId: imageId, revisionId } },
  avatar: { state: 'available', value: image },
  banner: { state: 'available', value: image },
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
          ? { state: 'available', value: image }
          : { state: 'none', value: null },
        rules: command.presentation.rules ? available.rules : { state: 'none', value: null },
      },
    }),
    select: async (choice) =>
      choice.kind === 'image'
        ? { kind: 'image', image: { ...image, id: choice.mediaId } }
        : {
            kind: 'rules',
            rules: {
              postId: choice.postId,
              revisionId: choice.revisionId,
              title: 'A thoughtful reading room',
              summary: 'Discuss the work, respect other readers, and mark spoilers.',
            },
          },
    upload: async () => ({ id: imageId }),
    resume: async (id) => ({ id }),
  };
}
