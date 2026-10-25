SELECT s.subject_id::text AS id,
       COALESCE(labels.body, '{}'::jsonb) AS labels
FROM unnest(:subject_ids::uuid[]) AS input(id)
JOIN LATERAL (
  SELECT route, subject_id FROM semantic.subject
  WHERE route = get_byte(uuid_send(input.id), 10) * 256 + get_byte(uuid_send(input.id), 11)
    AND subject_id = input.id
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(language, body) AS body FROM semantic.fact
  WHERE route = s.route AND subject_id = s.subject_id AND kind <> 'statement'
    AND kind = 'label' AND operation = 'assert'
) AS labels ON true
WHERE s.route / 16 = :partition_no::integer;
