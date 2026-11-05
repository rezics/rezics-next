WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :population_id::uuid AS population_id,
         :target_id::uuid AS target_id,
         :after_voter_id::nullable(uuid) AS after_voter_id,
         :limit::integer AS page_limit
), page_voters AS MATERIALIZED (
  SELECT voter.voter_id
  FROM input
  CROSS JOIN LATERAL (
    SELECT DISTINCT vote.voter_id
    FROM rating.population_vote AS vote
    WHERE vote.route = input.route AND vote.population_id = input.population_id
      AND vote.target_id = input.target_id
      AND (input.after_voter_id IS NULL OR vote.voter_id > input.after_voter_id)
    ORDER BY vote.voter_id
    LIMIT input.page_limit
  ) AS voter
)
SELECT vote.question_id AS "questionId", vote.voter_id AS "voterId", vote.units, vote.revision, vote.at::text AS at
FROM input
JOIN page_voters ON true
CROSS JOIN LATERAL (
  SELECT vote.question_id, vote.voter_id, vote.units, vote.revision, vote.at
  FROM rating.population_vote AS vote
  WHERE vote.route = input.route AND vote.population_id = input.population_id
    AND vote.target_id = input.target_id AND vote.voter_id = page_voters.voter_id
  OFFSET 0
) AS vote
ORDER BY vote.voter_id, vote.question_id;
