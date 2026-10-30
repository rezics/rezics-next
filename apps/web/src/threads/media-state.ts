import type { KernelClient } from '@rezics/client';

export type DraftMediaState = {
  id: string;
  state: 'reserved' | 'uploaded' | 'available' | 'rejected' | 'erased' | 'missing' | 'unavailable' | 'used';
};

/** Read each attached image once, server-side, after a media claim refusal. */
export async function readDraftMediaStates(
  client: KernelClient,
  authorization: string,
  mediaIds: readonly string[],
): Promise<DraftMediaState[]> {
  return Promise.all(
    mediaIds.map(async (id): Promise<DraftMediaState> => {
      try {
        const result = await client.media({ id }).get({ headers: { authorization } });
        if (result.error) {
          return { id, state: result.status === 404 ? 'missing' : 'unavailable' };
        }
        const media = result.data.media;
        return { id, state: media.state };
      } catch {
        return { id, state: 'unavailable' };
      }
    }),
  );
}
