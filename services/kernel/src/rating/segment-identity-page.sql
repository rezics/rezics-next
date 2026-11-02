WITH input AS (SELECT $3::uuid AS after_question)
SELECT question_id AS "questionId", target_id AS "targetId", units,
       revision, counted_target AS "countedTargetId", counted_revision AS "countedRevision",
       to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt"
FROM rating.vote CROSS JOIN input
WHERE route = $1::integer AND voter_id = $2::uuid
  AND (input.after_question IS NULL OR (question_id, target_id) > (input.after_question, $4::uuid))
  AND (question_id, target_id) <= ($5::uuid, $6::uuid)
ORDER BY question_id, target_id
LIMIT 64
FOR UPDATE;
