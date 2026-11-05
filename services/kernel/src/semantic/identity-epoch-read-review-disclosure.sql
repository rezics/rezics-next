SELECT s.subject_id::text AS subject_id,s.visibility
FROM unnest($1::uuid[],$2::integer[]) requested(original,route)
JOIN LATERAL (
  SELECT subject_id,visibility
  FROM semantic.subject
  WHERE (route,subject_id)=(requested.route,requested.original)
  LIMIT 1
) s ON true;
