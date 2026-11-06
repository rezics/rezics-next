import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryFullQuery, libraryListQuery, readLibraryResult } from './reads';
import { COLLECTION_MOVE_CURSOR_MAX_LENGTH } from './collection-placement-journey/model';

export type MoveChoices = { collections: { id: string; title: string }[]; next: string | null };
export type MovePlacements = { members: { id: string; title: string }[]; next: string | null };
type PlacementInput = { collectionId: string; revision: number; cursor?: string | undefined };
type MemberPageInput = { collectionId: string; cursor?: string | undefined };

function cursor(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input || input.length > COLLECTION_MOVE_CURSOR_MAX_LENGTH)
    throw new Error('Invalid move cursor');
  return input;
}
function frontier(input: unknown): string | null {
  if (input === null) return null;
  return cursor(input) ?? null;
}
function collectionId(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 128) throw new Error('Invalid move placement');
  return input;
}
function placementInput(input: PlacementInput): PlacementInput {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Invalid move placement');
  return { collectionId: collectionId(input.collectionId), revision: input.revision, cursor: cursor(input.cursor) };
}
function memberPageInput(input: MemberPageInput): MemberPageInput {
  return { collectionId: collectionId(input?.collectionId), cursor: cursor(input?.cursor) };
}

function projectMembers(page: {
  members: readonly { id?: unknown; subject?: { id?: string; label?: unknown } | null }[];
  next?: unknown;
}): MovePlacements {
  return {
    members: page.members.flatMap((member) => {
      if (typeof member.id !== 'string' || !member.subject) return [];
      const label = member.subject.label;
      return [
        {
          id: member.id,
          title:
            typeof label === 'string'
              ? label
              : ((label as { value?: string } | undefined)?.value ?? member.subject.id ?? member.id),
        },
      ];
    }),
    next: frontier(page.next ?? null),
  };
}

async function ownerAuthorization(request: Request, sessionEnv: Partial<SessionEnv>) {
  if (await prepareSession(request, sessionEnv)) throw new Error('Move session unavailable');
  const authorization = viewerCredential(request),
    owner = sessionSubject(request);
  if (!authorization || !owner) throw new Error('Move session unavailable');
  return { authorization, owner };
}

/** One bounded owner page, including destinations beyond the navigation's first page. */
export async function loadMoveChoices(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  next?: string,
): Promise<MoveChoices> {
  const continuation = cursor(next);
  const { authorization, owner } = await ownerAuthorization(request, sessionEnv);
  const page = readLibraryResult(
    await client.collections.get({
      query: { ...libraryListQuery(continuation), curatorAccountId: owner },
      headers: { authorization },
    }),
  );
  return {
    collections: page.collections.flatMap((collection) =>
      collection.membershipKind === 'curated' ? [{ id: collection.id, title: collection.title ?? collection.id }] : [],
    ),
    next: frontier(page.next),
  };
}

/** Current disclosed occurrences only. Header identity and revision stay with the destination header read. */
export async function loadMoveMembers(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: MemberPageInput,
): Promise<MovePlacements> {
  const pageInput = memberPageInput(input);
  const { authorization } = await ownerAuthorization(request, sessionEnv);
  const page = readLibraryResult(
    await client.collections({ collectionId: pageInput.collectionId }).members.get({
      query: libraryListQuery(pageInput.cursor),
      headers: { authorization },
    }),
  );
  if (!('members' in page)) throw new Error('Move destination unavailable');
  return projectMembers(page);
}

/** Compare the captured destination revision on every page; the final native CAS owns races. */
export async function loadMovePlacements(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: PlacementInput,
): Promise<MovePlacements> {
  const pageInput = placementInput(input);
  const { authorization, owner } = await ownerAuthorization(request, sessionEnv);
  const resource = client.collections({ collectionId: pageInput.collectionId });
  const [headerSettled, memberSettled] = await Promise.allSettled([
    resource.get({ query: libraryFullQuery(), headers: { authorization } }).then(readLibraryResult),
    resource.members
      .get({ query: libraryListQuery(pageInput.cursor), headers: { authorization } })
      .then(readLibraryResult),
  ]);
  if (headerSettled.status === 'rejected') throw headerSettled.reason;
  const { collection } = headerSettled.value;
  if (
    collection.curatorAccountId !== owner ||
    collection.membershipKind !== 'curated' ||
    collection.revision !== pageInput.revision
  )
    throw new Error('Move destination changed');
  if (memberSettled.status === 'rejected') throw memberSettled.reason;
  const page = memberSettled.value;
  if (!('members' in page)) throw new Error('Move destination unavailable');
  return projectMembers(page);
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
export const readCollectionMoveMembers = createServerFn({ method: 'GET' })
  .validator(memberPageInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMoveMembers(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
