SELECT targets.target_id AS "targetId", own.units, own.revision,
       to_char(own.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM unnest(:target_ids::uuid[]) AS targets(target_id)
JOIN LATERAL (
  SELECT units, revision, changed_at
  FROM rating.vote
  WHERE route = :route::integer AND voter_id = :voter_id::uuid AND question_id = :question_id::uuid
    AND counted_target IS NOT NULL AND counted_target = targets.target_id AND units IS NOT NULL
  LIMIT 1
) AS own ON true;
