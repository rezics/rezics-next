SELECT s.subject_id::text AS id, s.type
FROM unnest(:subject_ids::uuid[]) AS input(id)
JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  WHERE route = get_byte(uuid_send(input.id), 10) * 256 + get_byte(uuid_send(input.id), 11)
    AND subject_id = input.id AND visibility = 'visible'
  LIMIT 1
) AS s ON true
WHERE (get_byte(uuid_send(input.id), 10) * 256 + get_byte(uuid_send(input.id), 11)) / 16 = :partition_no::integer;
