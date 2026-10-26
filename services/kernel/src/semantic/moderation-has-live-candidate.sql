WITH input AS (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
)
SELECT 1 FROM input
JOIN semantic.subject s ON s.route = input.route AND s.subject_id = input.subject_id
WHERE EXISTS (
  SELECT property FROM semantic.candidate
  WHERE route = input.route AND subject_id = input.subject_id AND candidate_id = input.candidate_id
  UNION ALL
  SELECT property FROM semantic.fact f
  WHERE f.route = input.route AND f.subject_id = input.subject_id AND f.statement_id = input.candidate_id
    AND f.kind = 'statement' AND f.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = input.route AND newer.subject_id = f.subject_id
        AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
        AND newer.log_seq > f.log_seq
    )
  LIMIT 1
);
