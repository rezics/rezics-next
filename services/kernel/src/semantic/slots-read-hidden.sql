WITH input AS NOT MATERIALIZED (
  SELECT :viewer_moderator::boolean AS moderator, :viewer_account::uuid AS account
)
SELECT probed.candidate_id::text AS candidate_id
     , probed.subject_id::text AS subject_id
FROM input
CROSS JOIN jsonb_to_recordset(:candidates::jsonb) AS wanted(route integer, subject_id uuid, candidate_id uuid)
JOIN LATERAL (
  SELECT candidate_id, subject_id FROM semantic.hidden_candidate h
  WHERE h.route = wanted.route AND h.subject_id = wanted.subject_id AND h.candidate_id = wanted.candidate_id
  UNION ALL
  SELECT candidate_id, subject_id FROM semantic.record_lifecycle l
  WHERE l.route = wanted.route AND l.subject_id = wanted.subject_id AND l.candidate_id = wanted.candidate_id
    AND l.state IN ('deleted', 'purging', 'purged')
  UNION ALL
  SELECT candidate_id, subject_id FROM semantic.retraction t
  WHERE t.route = wanted.route AND t.subject_id = wanted.subject_id AND t.candidate_id = wanted.candidate_id
  UNION ALL
  SELECT candidate_id, subject_id FROM semantic.statement_disclosure d
  WHERE d.route = wanted.route AND d.subject_id = wanted.subject_id AND d.candidate_id = wanted.candidate_id
    AND (EXISTS (SELECT 1 FROM semantic.retraction t WHERE t.route = wanted.route
      AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id)
      OR (NOT d.disclosed AND NOT (input.moderator OR d.account_id = input.account)))
  OFFSET 0
  LIMIT 1
) probed ON true;
