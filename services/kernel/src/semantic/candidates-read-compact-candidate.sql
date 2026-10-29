WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT latest.revision, r.release, f.statement_id::text AS candidate_id, f.property, f.slot_id::text AS slot_id, f.relation
FROM semantic.fact f
CROSS JOIN input
JOIN semantic.subject s ON s.route = input.route AND s.subject_id = f.subject_id AND s.visibility = 'visible'
JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = input.route AND subject_id = f.subject_id
    AND recorded_transaction_id = f.recorded_transaction_id
  LIMIT 1
) r ON true
JOIN LATERAL (
  SELECT revision FROM semantic.revision
  WHERE route = input.route AND subject_id = s.subject_id ORDER BY revision DESC LIMIT 1
) latest ON true
WHERE f.route = input.route AND f.subject_id = :subject_id::uuid AND f.statement_id = :candidate_id::uuid
  AND f.kind = 'statement' AND f.operation = 'assert'
  AND NOT EXISTS (
    SELECT 1 FROM semantic.fact newer
    WHERE newer.route = input.route AND newer.subject_id = f.subject_id
      AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
      AND newer.log_seq > f.log_seq
  )
ORDER BY f.log_seq DESC LIMIT 1;
