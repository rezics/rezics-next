import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryListQuery, readLibraryResult, StaleCursorError, subjectOf, type LibrarySubject } from './reads';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from './personal-directory-address';

type FollowRead = NonNullable<Awaited<ReturnType<KernelClient['follows']['get']>>['data']>;
type RawFollow = FollowRead['follows'][number];

export type MineFollow = {
  targetId: string;
  targetType: RawFollow['targetType'];
  state: RawFollow['state'];
  reason: RawFollow['reason'];
  target: LibrarySubject | null;
  idempotencyKey: string;
};

export type MineFollowingPage = {
  signedIn: boolean;
  follows: MineFollow[];
  next: string | null;
  addressInvalid?: true;
  /** A successful native stale-cursor fallback; the requested address remains unchanged. */
  cursorReset?: true;
};

function present(follow: RawFollow): MineFollow {
  return {
    targetId: follow.targetId,
    targetType: follow.targetType,
    state: follow.state,
    reason: follow.reason,
    target: follow.target ? subjectOf(follow.target) : null,
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Reads one signed-in person's follows page with target labels included in the same kernel read. */
export async function loadMineFollowingPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string; invalidAddress?: true },
): Promise<MineFollowingPage> {
  if (await prepareSession(request, sessionEnv)) return { signedIn: false, follows: [], next: null };
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, follows: [], next: null };
  if (input.invalidAddress || !personalDirectoryAddress(input.cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following).valid)
    return { signedIn: true, follows: [], next: null, addressInvalid: true };
  const read = async (cursor?: string) => {
    const result = await client.follows.get({
      query: libraryListQuery(cursor, 20),
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    return readLibraryResult(result);
  };
  let page: FollowRead;
  let cursorReset = false;
  try {
    page = await read(input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await read();
    cursorReset = true;
  }
  return {
    signedIn: true,
    follows: page.follows.map(present),
    next: page.next,
    ...(cursorReset ? { cursorReset: true } : {}),
  };
}

/** Applies one unfollow after the session's CSRF token and bearer credential have been checked. */
export async function unfollowFollow(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { targetId: string; idempotencyKey: string },
): Promise<boolean> {
  if (await prepareSession(request, sessionEnv)) return false;
  const authorization = viewerCredential(request);
  if (!authorization) return false;
  const result = await client.follows({ targetId: input.targetId }).delete(undefined, {
    headers: { authorization, 'idempotency-key': input.idempotencyKey } as { 'idempotency-key': string },
  });
  return !result.error;
}
