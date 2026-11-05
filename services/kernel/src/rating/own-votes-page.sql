SELECT question_id AS "questionId", target_id AS "targetId", units, revision,
       changed_at AS "changedAt", counted_target AS "countedTarget"
FROM rating.vote
WHERE route = :route::integer AND voter_id = :voter_id::uuid AND units IS NOT NULL
  AND (question_id, target_id) > (:after_question::uuid, :after_target::uuid)
ORDER BY question_id, target_id
LIMIT 21;
