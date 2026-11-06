import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';

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
  const ids = [...new Set(mediaIds)];
  // Do not turn an oversized/invalid draft into a partial successful read.
  if (ids.length > 32 || ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))
    return ids.map((id) => ({ id, state: 'unavailable' }));
  return Promise.all(
    ids.map(async (id): Promise<DraftMediaState> => {
      try {
        const result = await client.media({ id }).get({ headers: { authorization } });
        if (result.error) {
          return { id, state: result.status === 404 ? 'missing' : 'unavailable' };
        }
        const media = result.data.media;
        if (media.id !== id || !['reserved', 'uploaded', 'available', 'rejected', 'erased'].includes(media.state))
          return { id, state: 'unavailable' };
        return { id, state: media.state };
      } catch {
        return { id, state: 'unavailable' };
      }
    }),
  );
}

/** Manual state inspection, never a publish command or permission/claimability check. */
export const checkDraftMediaStates = createServerFn({ method: 'GET' })
  .validator((input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 32 || input.some((id) => typeof id !== 'string'))
      throw new Error('Invalid draft images');
    return [...new Set(input as string[])];
  })
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { prepareSession, viewerCredential } = await import('../session/request');
    const { kernelClient } = await import('../kernel/client');
    const request = getRequest();
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    return authorization
      ? readDraftMediaStates(kernelClient(), authorization, data)
      : data.map((id): DraftMediaState => ({ id, state: 'unavailable' }));
  });
