WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
)
SELECT property, slot_id::text AS slot_id, relation FROM semantic.candidate, input
WHERE candidate.route = input.route AND candidate.subject_id = input.subject_id
  AND candidate.candidate_id = input.candidate_id
UNION ALL
SELECT property, slot_id::text AS slot_id, relation FROM semantic.fact f, input
WHERE f.route = input.route AND f.subject_id = input.subject_id AND f.statement_id = input.candidate_id
  AND f.kind = 'statement' AND f.operation = 'assert'
  AND NOT EXISTS (
    SELECT 1 FROM semantic.fact newer
    WHERE newer.route = input.route AND newer.subject_id = f.subject_id
      AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
      AND newer.log_seq > f.log_seq
  )
LIMIT 1;
