WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :name_limit::integer AS name_limit
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
  CROSS JOIN input
  WHERE ids.route / 16 = input.partition_no
)
SELECT requested.subject_id::text AS id,
       fact.kind,
       fact.language,
       fact.operation,
       fact.body,
       fact.slot_id::text AS slot_id,
       fact.log_seq
FROM requested
CROSS JOIN LATERAL (
  SELECT f.kind, f.language, f.operation, f.body, f.slot_id, f.log_seq
  FROM semantic.current_term_fact f
  CROSS JOIN input
  WHERE f.route = requested.route AND f.subject_id = requested.subject_id
    AND f.kind IN ('label', 'alias')
    AND f.route >= input.partition_no * 16
    AND f.route < (input.partition_no + 1) * 16
  ORDER BY f.kind COLLATE "C", f.language COLLATE "C", f.slot_id, f.log_seq
  LIMIT (SELECT name_limit FROM input)
) fact
ORDER BY requested.subject_id, fact.kind COLLATE "C", fact.language COLLATE "C", fact.slot_id, fact.log_seq;
