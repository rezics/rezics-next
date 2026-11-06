WITH input AS (
  SELECT $1::integer AS partition_no, $2::uuid AS job_id, $3::bigint AS job_epoch
)
SELECT bool_or(probe.building) AS building, bool_or(probe.affected) AS affected
FROM input
CROSS JOIN generate_series(input.partition_no * 16, input.partition_no * 16 + 15) AS home(route)
CROSS JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1 FROM library.identity_scope_plan p
      WHERE p.route=home.route AND p.job_id=input.job_id AND p.job_epoch=input.job_epoch AND p.state='building'
    ) AS building,
    EXISTS (
      SELECT 1 FROM library.collection c
      WHERE c.route=home.route
        AND EXISTS (
          SELECT 1 FROM library.collection_member m
          JOIN semantic.identity_epoch_admission_source s
            ON s.original=m.subject_id AND s.partition_no=input.partition_no AND s.job_id=input.job_id
          WHERE m.route=c.route AND m.collection_id=c.collection_id AND m.deletion_id IS NULL
        )
    ) AS affected
) AS probe;
