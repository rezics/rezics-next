WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
)
SELECT found.slot_id::text AS slot_id FROM input
CROSS JOIN LATERAL (
  SELECT c.slot_id FROM semantic.candidate c
  WHERE c.route = input.route AND c.subject_id = input.subject_id AND c.candidate_id = input.candidate_id
  UNION ALL
  SELECT f.slot_id FROM (
    SELECT slot_id FROM semantic.fact
    WHERE route = input.route AND subject_id = input.subject_id AND statement_id = input.candidate_id
      AND kind = 'statement' AND statement_id IS NOT NULL
    ORDER BY log_seq DESC LIMIT 1
  ) f
  LIMIT 1
) found;
