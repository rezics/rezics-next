WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_ids::uuid[] AS candidate_ids,
         :viewer_moderator::boolean AS moderator, :viewer_account::uuid AS account
)
SELECT h.candidate_id::text FROM input JOIN semantic.hidden_candidate h
  ON h.route = input.route AND h.subject_id = input.subject_id AND h.candidate_id = ANY(input.candidate_ids)
UNION ALL
SELECT d.candidate_id::text FROM input JOIN semantic.statement_disclosure d
  ON d.route = input.route AND d.subject_id = input.subject_id AND d.candidate_id = ANY(input.candidate_ids)
WHERE NOT d.disclosed AND NOT (input.moderator OR d.account_id = input.account);
