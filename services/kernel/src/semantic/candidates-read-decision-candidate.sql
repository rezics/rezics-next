WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT latest.revision, latest.release, c.candidate_id::text, c.property, c.slot_id::text, c.relation
FROM semantic.subject s
CROSS JOIN input
JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = input.route AND subject_id = s.subject_id ORDER BY revision DESC LIMIT 1
) latest ON true
JOIN semantic.candidate c
  ON c.route = input.route AND c.subject_id = s.subject_id AND c.candidate_id = :candidate_id::uuid
WHERE s.route = input.route AND s.subject_id = :subject_id::uuid AND s.visibility = 'visible';
