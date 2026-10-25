WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :subject_ids::uuid[] AS subject_ids
)
SELECT s.subject_id::text AS id,
       f.slot_id::text AS slot_id,
       f.log_seq,
       f.operation,
       f.kind,
       f.language,
       f.property,
       f.statement_id::text AS statement_id,
       f.body
FROM semantic.subject AS s
CROSS JOIN input
LEFT JOIN semantic.fact AS f ON f.route = s.route AND f.subject_id = s.subject_id
  AND f.route >= input.partition_no * 16 AND f.route < (input.partition_no + 1) * 16
WHERE s.route >= input.partition_no * 16
  AND s.route < (input.partition_no + 1) * 16
  AND s.subject_id = ANY(input.subject_ids)
ORDER BY s.subject_id, f.slot_id, f.log_seq;
