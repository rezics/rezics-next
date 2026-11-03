import type { CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { LibraryProfileAnchor, LibraryProfileSource } from './profile-source.ts';

export type VndbEntryReview = { uploadId: string; ordinal: number; reviewId: string; source: string };
export function vndbSourceFingerprint(observation: {
  anchor: LibraryProfileAnchor;
  source: NonNullable<LibraryProfileSource>;
}): string {
  const { anchor, source } = observation;
  return JSON.stringify([
    anchor.subjectId,
    anchor.acceptingType,
    String(anchor.identityEpoch),
    anchor.component.partition,
    anchor.component.epoch,
    String(anchor.component.position),
    source.kind === 'supported' ? source.pin.releaseDigest : null,
  ]);
}
/** Runs inside the native entry command after receipt lookup, before any fresh effect.
 * The same owner row lock orders cancellation/deletion against entry admission. */
export async function admitVndbEntry(
  tx: CommandTransaction,
  accountId: string,
  route: number,
  review: VndbEntryReview,
) {
  const result = await tx.query<{ active: boolean; review_id: string | null; status: string | null }>(
    `SELECT state='active' AND expires_at>clock_timestamp() AS active,
      decisions->$4->>'reviewId' AS review_id, decisions->$4->>'status' AS status
     FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
    [route, accountId, review.uploadId, String(review.ordinal)],
  );
  const current = result.rows[0];
  if (
    !current?.active ||
    current.review_id !== review.reviewId ||
    !['applying', 'failed'].includes(current.status ?? '')
  )
    throw new ProblemError('conflict');
}
