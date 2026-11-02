import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryFullQuery, libraryListQuery, readLibraryResult } from './reads';

export type MoveChoices = { collections: { id: string; title: string }[]; next: string | null };
export type MovePlacements = { members: { id: string; title: string }[]; next: string | null };
type PlacementInput = { collectionId: string; revision: number; cursor?: string | undefined };

function cursor(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input || input.length > 8192) throw new Error('Invalid move cursor');
  return input;
}
function placementInput(input: PlacementInput): PlacementInput {
  if (
    !input ||
    typeof input.collectionId !== 'string' ||
    !input.collectionId ||
    input.collectionId.length > 128 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  )
    throw new Error('Invalid move placement');
  return { collectionId: input.collectionId, revision: input.revision, cursor: cursor(input.cursor) };
}

/** One bounded owner page, including destinations beyond the navigation's first page. */
export async function loadMoveChoices(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  next?: string,
): Promise<MoveChoices> {
  if (await prepareSession(request, sessionEnv)) throw new Error('Move session unavailable');
  const authorization = viewerCredential(request),
    owner = sessionSubject(request);
  if (!authorization || !owner) throw new Error('Move session unavailable');
  const page = readLibraryResult(
    await client.collections.get({
      query: { ...libraryListQuery(next), curatorAccountId: owner },
      headers: { authorization },
    }),
  );
  return {
    collections: page.collections.flatMap((collection) =>
      collection.membershipKind === 'curated' ? [{ id: collection.id, title: collection.title ?? collection.id }] : [],
    ),
    next: page.next,
  };
}

/** Compare the captured destination revision on every page; the final native CAS owns races. */
export async function loadMovePlacements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: PlacementInput,
): Promise<MovePlacements> {
  placementInput(input);
  if (await prepareSession(request, sessionEnv)) throw new Error('Move session unavailable');
  const authorization = viewerCredential(request),
    owner = sessionSubject(request);
  if (!authorization || !owner) throw new Error('Move session unavailable');
  const resource = client.collections({ collectionId: input.collectionId });
  const [header, result] = await Promise.all([
    resource.get({ query: libraryFullQuery(), headers: { authorization } }),
    resource.members.get({ query: libraryListQuery(input.cursor), headers: { authorization } }),
  ]);
  const { collection } = readLibraryResult(header);
  if (
    collection.curatorAccountId !== owner ||
    collection.membershipKind !== 'curated' ||
    collection.revision !== input.revision
  )
    throw new Error('Move destination changed');
  const page = readLibraryResult(result);
  if (!('members' in page)) throw new Error('Move destination unavailable');
  return {
    members: page.members.flatMap((member) => {
      if (!('id' in member) || !member.subject) return [];
      const label = member.subject.label;
      return [{ id: member.id, title: typeof label === 'string' ? label : (label?.value ?? member.subject.id) }];
    }),
    next: page.next,
  };
}

export const readCollectionMoveChoices = createServerFn({ method: 'GET' })
  .validator(cursor)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMoveChoices(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
export const readCollectionMovePlacements = createServerFn({ method: 'GET' })
  .validator(placementInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMovePlacements(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
