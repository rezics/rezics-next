WITH input AS (SELECT $1::integer AS home, $2::uuid AS job_id, $3::bigint AS job_epoch)
SELECT count(*)::integer AS building
FROM library.identity_scope_plan p, input
WHERE p.job_id=input.job_id AND p.job_epoch=input.job_epoch AND p.state IN ('building','sealed')
  AND p.route BETWEEN input.home*16 AND input.home*16+15;
