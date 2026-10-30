WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_ids::uuid[] AS candidate_ids,
         :viewer_moderator::boolean AS moderator, :viewer_account::uuid AS account
)
SELECT probed.candidate_id::text AS candidate_id
FROM input CROSS JOIN unnest(input.candidate_ids) AS wanted(candidate_id)
JOIN LATERAL (
  SELECT candidate_id FROM semantic.hidden_candidate h
  WHERE h.route = input.route AND h.subject_id = input.subject_id AND h.candidate_id = wanted.candidate_id
  UNION ALL
  SELECT candidate_id FROM semantic.record_lifecycle l
  WHERE l.route = input.route AND l.subject_id = input.subject_id AND l.candidate_id = wanted.candidate_id
    AND l.state IN ('deleted', 'purging', 'purged')
  UNION ALL
  SELECT candidate_id FROM semantic.retraction t
  WHERE t.route = input.route AND t.subject_id = input.subject_id AND t.candidate_id = wanted.candidate_id
  UNION ALL
  SELECT candidate_id FROM semantic.statement_disclosure d
  WHERE d.route = input.route AND d.subject_id = input.subject_id AND d.candidate_id = wanted.candidate_id
    AND (EXISTS (SELECT 1 FROM semantic.retraction t WHERE t.route = input.route
      AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id)
      OR (NOT d.disclosed AND NOT (input.moderator OR d.account_id = input.account)))
  OFFSET 0
  LIMIT 1
) probed ON true;
