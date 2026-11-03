SELECT selected.counted_target_id AS "countingTargetId",
       own.target_id AS "originalTargetId",
       own.units,
       own.revision,
       own.counted_revision AS "countedRevision",
       to_char(own.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt",
       own.transaction_id AS "transactionId"
FROM unnest(:counted_target_ids::uuid[]) AS selected(counted_target_id)
JOIN LATERAL (
  SELECT target_id, units, revision, counted_revision, changed_at, transaction_id
  FROM rating.vote
  WHERE route = :route::integer
    AND voter_id = :voter_id::uuid
    AND question_id = :question_id::uuid
    AND counted_target = selected.counted_target_id
  LIMIT 1
) AS own ON true;
