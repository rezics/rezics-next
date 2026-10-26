WITH page_cursor AS (
  SELECT :after_question_id::nullable(uuid) AS question_id,
         :after_target_id::nullable(uuid) AS target_id
)
DELETE FROM rating.vote AS vote USING page_cursor
WHERE vote.route = :route::integer AND vote.voter_id = :voter_id::uuid
  AND (page_cursor.question_id IS NULL OR (vote.question_id, vote.target_id) >
       (page_cursor.question_id, page_cursor.target_id))
  AND (vote.question_id, vote.target_id) <= (:through_question_id::uuid, :through_target_id::uuid);
