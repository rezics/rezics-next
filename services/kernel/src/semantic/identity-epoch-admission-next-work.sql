WITH parameters AS (SELECT $1::integer cursor)
SELECT coalesce(
 (SELECT partition_no FROM semantic.identity_epoch_job WHERE state IN ('preparing','cancelling') AND partition_no>=(SELECT cursor FROM parameters) ORDER BY partition_no LIMIT 1),
 (SELECT partition_no FROM semantic.identity_epoch_job WHERE state IN ('preparing','cancelling') ORDER BY partition_no LIMIT 1)
) partition_no;
