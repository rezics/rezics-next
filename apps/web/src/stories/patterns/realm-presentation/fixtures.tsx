import type { RealmAppearanceAdapter } from '../../../community/realm-presentation';
import { createKernelClient } from '@rezics/client';
import { readRealmAppearance } from '../../../community/realm-presentation-native';
import {
  available,
  configured,
  image,
  bannerImage,
  imageId,
  revisionId,
  appearanceRecording,
} from '../../../kernel/fake/community';
export { available, configured, image, bannerImage, imageId, revisionId } from '../../../kernel/fake/community';

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

/** Exercise the same explicit native responses as the configured Storybook page host. */
export async function readFixtureAppearance(snapshot = available) {
  const client = createKernelClient('https://kernel.story', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const recording = await appearanceRecording(request, snapshot);
      if (!recording) throw new Error(`Unexpected story request ${request.method} ${new URL(request.url).pathname}`);
      const { status = 200, ...body } = recording;
      return Response.json(body, { status });
    }) as typeof fetch,
  });
  return readRealmAppearance(client, 'Bearer recorded-story-token', snapshot.realmId);
}
