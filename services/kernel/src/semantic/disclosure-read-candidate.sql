WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :candidate_id::uuid AS candidate_id
)
SELECT s.visibility,
       s.security_revision::text AS security_revision,
       (c.candidate_id IS NOT NULL OR f.statement_id IS NOT NULL) AS known,
       (h.candidate_id IS NOT NULL) AS hidden
FROM input i
JOIN semantic.subject s
  ON s.route = i.route AND s.subject_id = i.subject_id
LEFT JOIN semantic.candidate c
  ON c.route = i.route AND c.subject_id = s.subject_id AND c.candidate_id = i.candidate_id
LEFT JOIN LATERAL (
  SELECT fact.statement_id
  FROM semantic.fact fact
  WHERE fact.route = i.route AND fact.subject_id = s.subject_id AND fact.statement_id = i.candidate_id
    AND fact.kind = 'statement' AND fact.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = i.route AND newer.subject_id = fact.subject_id
        AND newer.slot_id = fact.slot_id AND newer.statement_id = fact.statement_id
        AND newer.log_seq > fact.log_seq
    )
  LIMIT 1
) f ON true
LEFT JOIN semantic.hidden_candidate h
  ON h.route = i.route AND h.subject_id = s.subject_id AND h.candidate_id = i.candidate_id;
