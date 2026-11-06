WITH input AS (SELECT $1::integer AS home, $2::uuid AS job_id)
SELECT count(*)::integer AS affected
FROM (
  SELECT DISTINCT r.route,r.collection_id
  FROM input
  JOIN library.canonical_source_reference r
    ON r.route BETWEEN input.home*16 AND input.home*16+15
  JOIN semantic.identity_epoch_change c
    ON c.partition_no=input.home AND c.job_id=input.job_id AND c.original=r.stored_subject_id
  UNION
  SELECT DISTINCT f.route,f.collection_id
  FROM input
  JOIN library.canonical_source_fact f
    ON f.route BETWEEN input.home*16 AND input.home*16+15
  JOIN semantic.identity_epoch_change c
    ON c.partition_no=input.home AND c.job_id=input.job_id AND c.original=f.stored_subject_id
) sources;
