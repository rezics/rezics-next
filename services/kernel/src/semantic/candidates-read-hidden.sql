WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
)
SELECT 1 FROM input JOIN semantic.hidden_candidate h
  ON h.route = input.route AND h.subject_id = input.subject_id AND h.candidate_id = input.candidate_id
UNION ALL
SELECT 1 FROM input JOIN semantic.record_lifecycle l
  ON l.route = input.route AND l.subject_id = input.subject_id AND l.candidate_id = input.candidate_id
WHERE l.state IN ('deleted','purging','purged')
UNION ALL
SELECT 1 FROM input JOIN semantic.statement_disclosure d
  ON d.route = input.route AND d.subject_id = input.subject_id AND d.candidate_id = input.candidate_id
WHERE (NOT d.disclosed OR EXISTS (SELECT 1 FROM semantic.retraction t
      WHERE t.route = input.route AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id));
