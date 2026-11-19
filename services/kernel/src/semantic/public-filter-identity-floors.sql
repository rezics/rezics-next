-- The final Subject row must still have this visible security revision on the decision snapshot.
SELECT s.subject_id::text AS id, s.visibility = 'visible' AS visible, s.security_revision::text AS revision
FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route, id)
CROSS JOIN LATERAL (
  SELECT subject_id, visibility, security_revision FROM semantic.subject
  WHERE (route, subject_id) = (wanted.route, wanted.id) LIMIT 1
) s;
