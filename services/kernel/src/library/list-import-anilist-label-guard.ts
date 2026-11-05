import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { requireRoute } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { readLibraryProfileAnchor } from './profile-source.ts';

export const aniListDigest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
export type AniListLabelGuard = {
  importId: string;
  ordinal: number;
  reviewId: string;
  reviewDigest: string;
  sourceDigest: string;
  subjectId: string;
  identityEpoch: string;
  labelRevision?: number;
};
/** Deferred errors let an original native receipt replay before fresh admission fails. */
export async function prepareAniListLabel(
  deps: { pool: Pool; access?: Access },
  actor: AccountActor,
  guard: AniListLabelGuard,
  at: AuthoritativeTime,
): Promise<{ error?: unknown }> {
  try {
    if (!deps.access) throw new LibraryConflictError();
    const observation = await readLibraryProfileAnchor(
      { pool: deps.pool, access: deps.access, actor, at, deadline: deadlineFor(5000) },
      guard.subjectId,
    );
    if (
      !observation ||
      observation.subjectId !== guard.subjectId ||
      String(observation.identityEpoch) !== guard.identityEpoch
    )
      throw new LibraryConflictError();
    return {};
  } catch (error) {
    return { error };
  }
}
/** Fresh effects share-lock the installed upload and row against cancel/remove/review refresh. */
export async function assertAniListLabel(tx: Pick<PoolClient, 'query'>, actor: AccountActor, guard: AniListLabelGuard) {
  const args = [requireRoute(actor.accountId), actor.accountId, guard.importId];
  const header = (
    await tx.query<{ payload: { cancelled: boolean } }>(
      'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR SHARE',
      args,
    )
  ).rows[0];
  const row = (
    await tx.query<{ payload: { source: unknown; labelReview?: { id: string } } }>(
      'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4 FOR SHARE',
      [...args, guard.ordinal],
    )
  ).rows[0];
  if (
    !header ||
    header.payload.cancelled ||
    !row ||
    row.payload.labelReview?.id !== guard.reviewId ||
    aniListDigest(row.payload.source) !== guard.sourceDigest ||
    aniListDigest(row.payload.labelReview) !== guard.reviewDigest
  )
    throw new LibraryConflictError();
}
