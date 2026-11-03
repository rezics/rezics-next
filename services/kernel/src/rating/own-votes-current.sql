SELECT own.* FROM jsonb_to_recordset(:keys::jsonb) AS k(question_id uuid, target_id uuid)
JOIN LATERAL (
  SELECT question_id AS "questionId", target_id AS "targetId", units, revision,
         changed_at AS "changedAt", counted_target AS "countedTarget"
  FROM rating.vote
  WHERE route = :route::integer AND voter_id = :voter_id::uuid
    AND question_id = k.question_id AND target_id = k.target_id AND units IS NOT NULL
  LIMIT 1
) own ON true;
