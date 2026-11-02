WITH input AS (
  SELECT $1::integer AS route, $2::uuid AS voter_id,
         $3::uuid AS after_question, $4::uuid AS after_target,
         $5::uuid AS through_question, $6::uuid AS through_target
)
SELECT v.question_id AS "questionId", v.target_id AS "targetId", v.units,
       v.revision, v.counted_target AS "countedTargetId", v.counted_revision AS "countedRevision",
       to_char(v.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt"
FROM rating.vote AS v CROSS JOIN input AS i
WHERE v.route = i.route AND v.voter_id = i.voter_id
  AND (i.after_question IS NULL OR (v.question_id, v.target_id) > (i.after_question, i.after_target))
  AND (v.question_id, v.target_id) <= (i.through_question, i.through_target)
ORDER BY v.question_id, v.target_id
LIMIT 64
FOR UPDATE OF v;
