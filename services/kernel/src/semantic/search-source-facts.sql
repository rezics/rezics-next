WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
)
SELECT 'term'::text AS entry_kind, requested.route, requested.subject_id::text AS id, fact.slot_id::text AS slot_id,
       fact.log_seq, fact.operation, fact.kind, fact.language, fact.property, fact.statement_id::text AS candidate_id,
       fact.body, fact.release
FROM requested
CROSS JOIN LATERAL (
  SELECT f.slot_id, f.log_seq, f.operation, f.kind, f.language, f.property,
         f.statement_id, f.body, f.release
  FROM semantic.current_term_fact f
  CROSS JOIN input
  WHERE f.route = requested.route AND f.subject_id = requested.subject_id AND f.kind <> 'statement'
    AND f.route >= input.partition_no * 16
    AND f.route < (input.partition_no + 1) * 16
  ORDER BY f.slot_id, f.log_seq
) fact;
