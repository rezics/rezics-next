WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT s.type, latest.revision FROM semantic.subject s
  CROSS JOIN input
  JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route = input.route AND subject_id = s.subject_id
    ORDER BY revision DESC LIMIT 1) latest ON true
  WHERE s.route = input.route AND s.subject_id = :subject_id::uuid AND s.visibility = 'visible';
