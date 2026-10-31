WITH input AS MATERIALIZED (
  SELECT *
  FROM jsonb_to_recordset(:candidates::jsonb) AS candidate(
    route integer,
    subject_id uuid,
    candidate_id uuid
  )
)
SELECT input.subject_id::text AS subject_id, input.candidate_id::text AS candidate_id,
       live.property, live.slot_id::text AS slot_id, live.relation
FROM input
JOIN LATERAL (
  SELECT property, slot_id, relation
  FROM semantic.candidate
  WHERE route = input.route AND subject_id = input.subject_id AND candidate_id = input.candidate_id
  UNION ALL
  SELECT f.property, f.slot_id, f.relation
  FROM semantic.fact f
  WHERE f.route = input.route AND f.subject_id = input.subject_id AND f.statement_id = input.candidate_id
    AND f.kind = 'statement' AND f.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = input.route AND newer.subject_id = f.subject_id
        AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
        AND newer.log_seq > f.log_seq
    )
  LIMIT 1
) AS live ON true;
