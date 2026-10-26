WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id, ids.slot_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[], :slot_ids::uuid[]) AS ids(route, subject_id, slot_id)
)
SELECT requested.route,
       requested.subject_id::text AS subject_id,
       requested.slot_id::text AS slot_id,
       adoption.mode,
       adoption.selection
FROM requested
LEFT JOIN LATERAL (
  SELECT mode, selection
  FROM semantic.adoption
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.subject_id AND slot_id = requested.slot_id
    AND context_id = '00000000-0000-8000-8000-000000000000'
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  ORDER BY head DESC
  LIMIT 1
) adoption ON true;
