import { followingKind } from './following-kind-navigation/address';
import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  LibraryReadForbiddenError,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type LibrarySubject,
} from './reads';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from './personal-directory-address';
import {
  deleteFollow,
  followListQuery,
  followWriteHeaders,
  getFollowList,
  type FollowEdge,
  type FollowListPage,
} from './follow-transport';

type FollowRead = FollowListPage;
type RawFollow = FollowEdge;

export type MineFollow = {
  targetId: string;
  targetType: RawFollow['targetType'];
  state: RawFollow['state'];
  reason: RawFollow['reason'];
  target: LibrarySubject | null;
  destination?: RawFollow['destination'];
  actions?: RawFollow['actions'];
  idempotencyKey: string;
};

export type MineFollowingPage = {
  signedIn: boolean;
  follows: MineFollow[];
  next: string | null;
  addressInvalid?: true;
  /** An ordinary native list denial, with no row or command authority. */
  forbidden?: true;
  kindUnavailable?: true;
  /** A successful native stale-cursor fallback; the requested address remains unchanged. */
  cursorReset?: true;
};

/** Subject and collection/space summaries have `type`; account and deleted-account targets do not. */
function followSubject(target: RawFollow['target']): LibrarySubject | null {
  if (!target || !('id' in target) || !('type' in target)) return null;
  return subjectOf(target);
}

function present(follow: RawFollow): MineFollow {
  return {
    targetId: follow.targetId,
    targetType: follow.targetType,
    state: follow.state,
    reason: follow.reason,
    target: followSubject(follow.target),
    ...(follow.destination ? { destination: follow.destination } : {}),
    ...(follow.actions ? { actions: follow.actions } : {}),
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Reads one signed-in person's follows page with target labels included in the same kernel read. */
export async function loadMineFollowingPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string; invalidAddress?: true; kind?: unknown },
): Promise<MineFollowingPage> {
  if (await prepareSession(request, sessionEnv)) return { signedIn: false, follows: [], next: null };
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, follows: [], next: null };
  const kind = followingKind(input.kind);
  if (
    !kind ||
    input.invalidAddress ||
    !personalDirectoryAddress(input.cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following).valid
  )
    return { signedIn: true, follows: [], next: null, addressInvalid: true };
  const read = async (cursor?: string) => {
    const result = await getFollowList(
      client,
      authorization,
      followListQuery(cursor, 20, kind === 'all' ? undefined : kind),
    );
    try {
      return readLibraryResult(result);
    } catch (error) {
      if (error instanceof LibraryReadForbiddenError) return null;
      throw error;
    }
  };
  let page: FollowRead | null;
  let cursorReset = false;
  try {
    page = await read(input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await read();
    cursorReset = true;
  }
  if (page === null) return { signedIn: true, forbidden: true, follows: [], next: null };
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
  const result = await deleteFollow(client, input.targetId, followWriteHeaders(authorization, input.idempotencyKey));
  return !result.error;
}
