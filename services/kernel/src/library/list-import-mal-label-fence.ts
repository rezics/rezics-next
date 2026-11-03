import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import { deadlineClient } from '../access/authenticate.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { LibraryConflictError } from './entries.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import { malDigest } from './list-import-mal-tags.ts';
import type { MalRow } from './list-import-mal-parser.ts';

/** Native command operand, included in the original command digest, never a capability. */
export type MalLabelFence = {
  id: string;
  row: number;
  version: string;
  sourceDigest: string;
  selectionDigest: string;
  subject: string;
  epoch: string;
  acceptingType: string;
  binding: { subject: string; route: number; source: string; externalId: string } | null;
  label: { id: string; revision: number; name?: string } | null;
};

/** Preparation uses the same current Subject controls as the installed MAL producer.
 * Capture failures for native execution: an original receipt is still replayable.
 */
export async function prepareMalLabelFence(
  deps: { pool: Pool; access: Access },
  actor: AccountActor,
  fence: MalLabelFence,
  at: AuthoritativeTime,
  deadline: number,
) {
  const observation = await readLibraryProfileSourceObservation(
    { ...deps, actor, at, deadline }, fence.subject,
  );
  if (!observation || observation.source.subjectId !== fence.subject ||
    String(observation.anchor.identityEpoch) !== fence.epoch ||
    observation.anchor.acceptingType !== fence.acceptingType) throw new LibraryConflictError();
  if (fence.binding) {
    const b = fence.binding;
    const claim = await deadlineClient(deps.pool, deadline).query<{ subject_id: string }>(
      'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
      [b.route, b.source, b.externalId],
    );
    if (claim.rows[0]?.subject_id !== b.subject) throw new LibraryConflictError();
  }
}

/** Fresh effects serialize with refreshed review, cancellation, removal and expiry.
 * This reads one upload key and one addressed label key, never owner-wide labels/history.
 */
export async function assertMalLabelFence(
  tx: Pick<PoolClient, 'query'>,
  actor: AccountActor,
  fence: MalLabelFence,
) {
  const route = routeOf(actor.accountId)!;
  const found = await tx.query<{
    row: MalRow;
    version: string;
    source_digest: string;
    selection_digest: string;
    subject: string;
  }>(
    `SELECT document->'rows'->$4::integer AS row,
      document->'reviews'->$5::text->>'version' AS version,
      document->'reviews'->$5::text->'labels'->>'sourceDigest' AS source_digest,
      document->'reviews'->$5::text->'labels'->>'selectionDigest' AS selection_digest,
      document->'reviews'->$5::text->>'target' AS subject
    FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND id=$3
      AND expires_at>clock_timestamp() AND NOT (document->>'canceled')::boolean FOR SHARE`,
    [route, actor.accountId, fence.id, fence.row, String(fence.row)],
  );
  const current = found.rows[0];
  if (!current || current.version !== fence.version || current.source_digest !== fence.sourceDigest ||
    current.selection_digest !== fence.selectionDigest || current.subject !== fence.subject ||
    malDigest(current.row) !== fence.sourceDigest) throw new LibraryConflictError();
  if (fence.label) {
    const label = await tx.query<{ revision: number; name: string }>(
      `SELECT revision,normalized_name AS name FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`,
      [route, actor.accountId, fence.label.id],
    );
    if (label.rows[0]?.revision !== fence.label.revision ||
      (fence.label.name !== undefined && label.rows[0]?.name !== fence.label.name)) throw new LibraryConflictError();
  }
}
