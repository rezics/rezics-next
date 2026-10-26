WITH input AS (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT s.visibility, s.security_revision::text AS "securityRevision", latest.revision, latest.release
FROM input
JOIN semantic.subject s ON s.route = input.route AND s.subject_id = input.subject_id
JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = input.route AND subject_id = s.subject_id
  ORDER BY revision DESC LIMIT 1
) latest ON true;
