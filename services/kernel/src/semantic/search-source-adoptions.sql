WITH requested AS MATERIALIZED (
  SELECT input.route, input.subject_id, input.slot_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[], :slot_ids::uuid[]) AS input(route, subject_id, slot_id)
)
SELECT input.route,
       input.subject_id::text AS subject_id,
       input.slot_id::text AS slot_id,
       adoption.mode,
       adoption.selection
FROM requested input
LEFT JOIN LATERAL (
  SELECT mode, selection
  FROM semantic.adoption
  WHERE route = input.route AND subject_id = input.subject_id AND slot_id = input.slot_id
    AND context_id = '00000000-0000-8000-8000-000000000000'
  ORDER BY head DESC
  LIMIT 1
) adoption ON true;
