-- The caller derives each route from its Subject ID on the current decision snapshot.
SELECT requested.subject_id::text AS id, subject.visibility
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, subject_id)
LEFT JOIN LATERAL (
  SELECT s.visibility FROM semantic.subject s
  WHERE (s.route,s.subject_id)=(requested.route,requested.subject_id)
  LIMIT 1
) AS subject ON true;
