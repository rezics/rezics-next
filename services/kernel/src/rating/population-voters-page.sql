WITH page_cursor AS (
  SELECT :after_question_id::nullable(uuid) AS question_id, :after_voter_id::nullable(uuid) AS voter_id
)
SELECT vote.question_id AS "questionId", vote.voter_id AS "voterId", vote.units, vote.revision, vote.at::text AS at
FROM rating.population_vote AS vote CROSS JOIN page_cursor
WHERE vote.route = :route::integer AND vote.population_id = :population_id::uuid AND vote.target_id = :target_id::uuid
  AND (page_cursor.question_id IS NULL OR (vote.question_id, vote.voter_id) > (page_cursor.question_id, page_cursor.voter_id))
ORDER BY vote.question_id, vote.voter_id
LIMIT :limit::integer;
