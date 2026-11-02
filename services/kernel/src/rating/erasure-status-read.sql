WITH input AS (
  SELECT :route::integer AS route, :voter_id::uuid AS voter_id
), terminal AS (
  SELECT erasure.had_votes
  FROM rating.voter_state AS voter
  JOIN rating.erasure_page AS erasure
    ON erasure.route = voter.route
    AND erasure.voter_id = voter.voter_id
    AND erasure.page_id = voter.transition_id
    AND erasure.terminal
  CROSS JOIN input
  WHERE voter.route = input.route
    AND voter.voter_id = input.voter_id
    AND voter.state = 'ineligible'
)
SELECT
  EXISTS (SELECT 1 FROM terminal)
  AND NOT EXISTS (
    SELECT 1 FROM rating.vote
    WHERE route = input.route AND voter_id = input.voter_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM rating.voter_realm
    WHERE route = input.route AND voter_id = input.voter_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM rating.erasure_page
    WHERE route = input.route AND voter_id = input.voter_id AND NOT terminal
  ) AS done,
  COALESCE((SELECT had_votes FROM terminal LIMIT 1), false) AS "hadVotes"
FROM input;
