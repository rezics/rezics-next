WITH input AS NOT MATERIALIZED (SELECT :partition_no::integer AS partition_no)
SELECT present.id
FROM jsonb_to_recordset(:requests::jsonb) AS request(route integer, subject_id uuid, properties text[])
CROSS JOIN LATERAL (
  SELECT selected.subject_id::text AS id
  FROM semantic.search_selected selected
  CROSS JOIN input
  WHERE selected.route = request.route
    AND selected.subject_id = request.subject_id
    AND selected.property = ANY(request.properties)
    AND selected.active
    AND selected.route >= input.partition_no * 16
    AND selected.route < (input.partition_no + 1) * 16
  LIMIT 1
) present;
