import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryFullQuery, readLibraryResult } from './reads';

export type CollectionDestination = { id: string; title: string; revision: number };

/** Capture a current authorized destination revision, never infer it from navigation or member rows. */
export async function loadCollectionDestination(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<CollectionDestination | null> {
  if (await prepareSession(request, sessionEnv)) return null;
  const authorization = viewerCredential(request);
  const viewer = sessionSubject(request);
  if (!authorization || !viewer) return null;
  const { collection } = readLibraryResult(
    await client.collections({ collectionId: id }).get({
      query: libraryFullQuery(),
      headers: { authorization },
    }),
  );
  if (
    collection.id !== id ||
    collection.curatorAccountId !== viewer ||
    collection.membershipKind !== 'curated' ||
    !Number.isSafeInteger(collection.revision) ||
    collection.revision < 1
  )
    return null;
  return { id: collection.id, title: collection.title, revision: collection.revision };
}

export const readCollectionDestination = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (typeof input !== 'string' || !input || input.length > 128) throw new Error('Invalid Collection destination');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCollectionDestination(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
