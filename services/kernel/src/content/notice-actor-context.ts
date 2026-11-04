import type { Pool, PoolClient } from 'pg';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { readAvatarSummaries, type AvatarSummary } from './avatar.ts';

/** Internal dependency seam matching Accounts' bounded observation contract, never a public DTO. */
export type NoticeActorObservation =
  | Extract<PublicIdentity, { state: 'deleted' }>
  | (Extract<PublicIdentity, { state: 'active' }> & {
      avatarMediaId: string | null;
      nativeState: 'active' | 'suspended';
      authnFenced: boolean;
    });
export type NoticeActorObservationReader = (
  client: Pick<PoolClient, 'query'>,
  ids: readonly string[],
) => Promise<readonly NoticeActorObservation[]>;

export type NoticeActor =
  | Readonly<{
      state: 'available';
      accountId: string;
      displayName: string;
      handle: string | null;
      avatar: AvatarSummary | null;
      /** Retained transport field; stored profile URLs are never admitted. */
      avatarUrl: null;
      automated: boolean;
    }>
  | Readonly<{
      state: 'withheld';
      displayName: 'Former or unavailable account';
      handle: null;
      avatar: null;
      avatarUrl: null;
    }>
  | Readonly<{ state: 'system'; displayName: 'Moderation team'; handle: null; avatar: null; avatarUrl: null }>;

export function unavailableNoticeActor(): NoticeActor {
  return { state: 'withheld', displayName: 'Former or unavailable account', handle: null, avatar: null, avatarUrl: null };
}

function unchanged(before: PublicIdentity | NoticeActorObservation | undefined, after: PublicIdentity | NoticeActorObservation) {
  if (!before || before.id !== after.id || before.kind !== after.kind || before.state !== after.state) return false;
  if (before.state !== 'active' || after.state !== 'active') return false;
  if (
    before.handle !== after.handle ||
    before.displayName !== after.displayName ||
    before.automated !== after.automated ||
    before.operatorId !== after.operatorId
  ) return false;
  if ('avatarMediaId' in before && 'avatarMediaId' in after)
    return before.avatarMediaId === after.avatarMediaId &&
      before.nativeState === after.nativeState && before.authnFenced === after.authnFenced;
  return !('avatarMediaId' in before) && !('avatarMediaId' in after);
}

/** Two identical bounded Account observations surround Content's admitted Media read. */
export async function readNoticeActors(
  pool: Pool,
  ids: readonly string[],
  deadline: number,
  observe?: NoticeActorObservationReader,
): Promise<ReadonlyMap<string, NoticeActor>> {
  if (ids.length > 50) throw new RangeError('At most 50 notice identities');
  const unique = [...new Set(ids.filter((id) => routeOf(id) !== null))];
  if (!unique.length) return new Map();
  const routes = unique.map((id) => routeOf(id)!);
  return within(deadline, () => withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    // Until the native dependency is installed, the thin public reader admits identity only.
    // It supplies no reference or lifecycle facts from which avatar admission can be inferred.
    const read = (): Promise<readonly (PublicIdentity | NoticeActorObservation)[]> =>
      observe ? observe(client, unique) : readPublicIdentities(client, routes, unique);
    const before = new Map((await read()).map((row) => [row.id, row]));
    const mediaIds = [...new Set([...before.values()].flatMap((row) =>
      row.state === 'active' && row.kind === 'actor' && 'avatarMediaId' in row &&
      row.nativeState === 'active' && !row.authnFenced && row.avatarMediaId
        ? [row.avatarMediaId] : [],
    ))];
    const avatars = mediaIds.length ? await readAvatarSummaries(client, mediaIds) : new Map<string, AvatarSummary | null>();
    const after = new Map((await read()).map((row) => [row.id, row]));
    const result = new Map<string, NoticeActor>();
    for (const id of unique) {
      const current = after.get(id);
      if (!current || current.state !== 'active' || current.kind !== 'actor' || !unchanged(before.get(id), current)) continue;
      const avatar = 'avatarMediaId' in current && current.nativeState === 'active' &&
        !current.authnFenced && current.avatarMediaId ? avatars.get(current.avatarMediaId) ?? null : null;
      result.set(id, {
        state: 'available', accountId: id,
        displayName: current.displayName?.trim() || current.handle || 'Member',
        handle: current.handle, automated: current.automated, avatar, avatarUrl: null,
      });
    }
    return result;
  }));
}
