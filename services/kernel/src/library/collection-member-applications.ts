import type { CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';

export const COLLECTION_MEMBER_APPLICATION_LIMIT = 32;

export async function writeCollectionMemberApplication(
  tx: CommandTransaction,
  input: Readonly<{
    route: number;
    collectionId: string;
    memberId: string;
    appliedSubjectId: string;
    present: boolean;
  }>,
): Promise<{ memberSubjectId: string; changed: boolean }> {
  const args = [input.route, input.collectionId, input.memberId, input.appliedSubjectId];
  const member = await tx.query<{ subject_id: string; ordinal_key: string }>(
    `SELECT subject_id, ordinal_key FROM library.collection_member
      WHERE route=$1 AND collection_id=$2 AND member_id=$3 AND deletion_id IS NULL
      FOR UPDATE`,
    args.slice(0, 3),
  );
  const target = member.rows[0];
  if (!target) throw new ProblemError('not_found');
  if (!input.present) {
    const result = await tx.query(
      `DELETE FROM library.collection_member_application
        WHERE route=$1 AND collection_id=$2 AND member_id=$3 AND applied_subject_id=$4`,
      args,
    );
    return { memberSubjectId: target.subject_id, changed: result.rowCount === 1 };
  }

  const result = await tx.query<{ present: boolean; changed: boolean }>(
    `WITH existing AS (
       SELECT applied_subject_id, slot
       FROM library.collection_member_application
       WHERE route=$1 AND collection_id=$2 AND member_id=$3
     ), inserted AS (
       INSERT INTO library.collection_member_application
         (route, collection_id, member_id, applied_subject_id, slot, live_ordinal)
       SELECT $1, $2, $3, $4, candidate, $5
       FROM generate_series(1, $6::integer) AS slots(candidate)
       WHERE NOT EXISTS (SELECT 1 FROM existing WHERE applied_subject_id=$4 OR slot=candidate)
       ORDER BY candidate
       LIMIT 1
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM existing WHERE applied_subject_id=$4)
         OR EXISTS (SELECT 1 FROM inserted) AS present,
       EXISTS (SELECT 1 FROM inserted) AS changed`,
    [...args, target.ordinal_key, COLLECTION_MEMBER_APPLICATION_LIMIT],
  );
  if (!result.rows[0]?.present) throw new ProblemError('conflict');
  return { memberSubjectId: target.subject_id, changed: result.rows[0].changed };
}
