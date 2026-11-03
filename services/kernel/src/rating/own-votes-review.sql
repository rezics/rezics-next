SELECT selected.target_id AS "targetId", own.units, own.revision,
       own.counted_revision AS "countedRevision", own.counted_target AS "countedTarget",
       to_char(own.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt",
       own.transaction_id AS "transactionId"
FROM unnest(:target_ids::uuid[]) AS selected(target_id)
LEFT JOIN LATERAL (
  SELECT units, revision, counted_revision, counted_target, changed_at, transaction_id
  FROM rating.vote
  WHERE route = :route::integer AND voter_id = :voter_id::uuid
    AND question_id = :question_id::uuid AND target_id = selected.target_id
  LIMIT 1
) AS own ON true;
