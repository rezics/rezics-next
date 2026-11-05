SELECT own."targetId", own.units, own.revision, own.at
FROM unnest(:target_ids::uuid[]) AS targets(target_id)
JOIN LATERAL (
  SELECT target_id AS "targetId", units, revision,
         to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
  FROM rating.vote
  WHERE route = :route::integer AND voter_id = :voter_id::uuid AND question_id = :question_id::uuid
    AND target_id = targets.target_id AND units IS NOT NULL
  LIMIT 1
) AS own ON true;
