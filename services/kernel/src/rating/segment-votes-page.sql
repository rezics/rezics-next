WITH page_cursor AS (
  SELECT :after_question_id::nullable(uuid) AS question_id,
         :after_target_id::nullable(uuid) AS target_id,
         :limit_question_id::nullable(uuid) AS limit_question_id,
         :limit_target_id::nullable(uuid) AS limit_target_id
)
SELECT vote.question_id AS "questionId", vote.target_id AS "targetId",
       vote.counted_target AS "countedTargetId", vote.units, vote.counted_revision AS revision,
       vote.changed_at::text AS "changedAt"
FROM rating.vote AS vote CROSS JOIN page_cursor
WHERE vote.route = :route::integer AND vote.voter_id = :voter_id::uuid
  AND (page_cursor.question_id IS NULL OR (vote.question_id, vote.target_id) >
       (page_cursor.question_id, page_cursor.target_id))
  AND (page_cursor.limit_question_id IS NULL OR (vote.question_id, vote.target_id) <=
       (page_cursor.limit_question_id, page_cursor.limit_target_id))
ORDER BY vote.question_id, vote.target_id
LIMIT :limit::integer;
