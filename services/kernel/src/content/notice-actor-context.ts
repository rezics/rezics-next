import type { Pool } from 'pg';
import type { Static } from 'typebox';
import { readPublicIdentityObservations, type PublicIdentityObservation } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { readAvatarSummaries, type AvatarSummary } from './avatar.ts';
import type { AvatarSummarySchema } from './schemas.ts';

export type NoticeActor =
  | Readonly<{
      state: 'available';
      accountId: string;
      displayName: string;
      handle: string | null;
      avatar: Static<typeof AvatarSummarySchema>;
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
  return {
    state: 'withheld',
    displayName: 'Former or unavailable account',
    handle: null,
    avatar: null,
    avatarUrl: null,
  };
}

function unchanged(before: PublicIdentityObservation | undefined, after: PublicIdentityObservation) {
  if (!before || before.id !== after.id || before.kind !== after.kind || before.state !== after.state) return false;
  if (before.state !== 'active' || after.state !== 'active') return false;
  if (
    before.handle !== after.handle ||
    before.displayName !== after.displayName ||
    before.automated !== after.automated ||
    before.operatorId !== after.operatorId
  )
    return false;
  return (
    before.avatarMediaId === after.avatarMediaId &&
    before.nativeState === after.nativeState &&
    before.authnFenced === after.authnFenced
  );
}

/** Two identical bounded Account observations surround Content's admitted Media read. */
export async function readNoticeActors(
  pool: Pool,
  ids: readonly string[],
  deadline: number,
): Promise<ReadonlyMap<string, NoticeActor>> {
  if (ids.length > 50) throw new RangeError('At most 50 notice identities');
  const unique = [...new Set(ids.filter((id) => routeOf(id) !== null))];
  if (!unique.length) return new Map();
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const read = () => readPublicIdentityObservations(client, unique);
      const before = new Map((await read()).map((row) => [row.id, row]));
      const mediaIds = [
        ...new Set(
          [...before.values()].flatMap((row) =>
            row.state === 'active' &&
            row.kind === 'actor' &&
            row.nativeState === 'active' &&
            !row.authnFenced &&
            row.avatarMediaId
              ? [row.avatarMediaId]
              : [],
          ),
        ),
      ];
      const avatars = mediaIds.length
        ? await readAvatarSummaries(client, mediaIds)
        : new Map<string, AvatarSummary | null>();
      const after = new Map((await read()).map((row) => [row.id, row]));
      const result = new Map<string, NoticeActor>();
      for (const id of unique) {
        const current = after.get(id);
        if (!current || current.state !== 'active' || current.kind !== 'actor' || !unchanged(before.get(id), current))
          continue;
        const avatar =
          current.nativeState === 'active' && !current.authnFenced && current.avatarMediaId
            ? (avatars.get(current.avatarMediaId) ?? null)
            : null;
        result.set(id, {
          state: 'available',
          accountId: id,
          displayName: current.displayName?.trim() || current.handle || 'Member',
          handle: current.handle,
          automated: current.automated,
          avatar: avatar ? { ...avatar, variants: [...avatar.variants] } : null,
          avatarUrl: null,
        });
      }
      return result;
    }),
  );
}
