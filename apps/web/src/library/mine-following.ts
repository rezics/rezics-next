import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryLabel, LIBRARY_PAGE_LIMIT, libraryListQuery, readLibraryResult, StaleCursorError } from './reads';

type FollowRead = NonNullable<Awaited<ReturnType<KernelClient['follows']['get']>>['data']>;
type RawFollow = FollowRead['follows'][number];

export type MineFollow = {
  targetId: string;
  targetType: 'subject' | 'collection' | 'space';
  state: 'following' | 'unfollowed';
  reason: 'explicit' | 'library' | 'membership';
  target: { id: string; type: string; label: string; typeLabel?: string } | null;
  idempotencyKey: string;
};

export type MineFollowingPage = {
  signedIn: boolean;
  follows: MineFollow[];
  next: string | null;
};

function present(follow: RawFollow): MineFollow {
  return {
    targetId: follow.targetId,
    targetType: follow.targetType,
    state: follow.state,
    reason: follow.reason,
    target: follow.target
      ? { id: follow.target.id, type: follow.target.type, label: libraryLabel(follow.target.label, follow.target.id) }
      : null,
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Reads one signed-in person's follows page with target labels included in the same kernel read. */
export async function loadMineFollowingPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<MineFollowingPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, follows: [], next: null };
  const read = async (cursor?: string) => {
    const result = await client.follows.get({
      query: libraryListQuery(cursor, LIBRARY_PAGE_LIMIT),
      headers: { authorization },
    });
    return readLibraryResult(result);
  };
  let page: FollowRead;
  try {
    page = await read(input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await read();
  }
  return { signedIn: true, follows: page.follows.map(present), next: page.next };
}

/** Applies one unfollow after the session's CSRF token and bearer credential have been checked. */
export async function unfollowFollow(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { targetId: string; idempotencyKey: string },
): Promise<boolean> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return false;
  const result = await client.follows({ targetId: input.targetId }).delete(undefined, {
    headers: { authorization, 'idempotency-key': input.idempotencyKey } as { 'idempotency-key': string },
  });
  return !result.error;
}
