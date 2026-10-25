SELECT s.subject_id::text AS id, s.type
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS input(route, id)
JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  WHERE route = input.route AND subject_id = input.id AND visibility = 'visible'
  LIMIT 1
) AS s ON true;
