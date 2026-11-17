/* semantic.native-keyed:1:4 */
-- Keep the original successor lookup keyed by the full predecessor, including the separate root index.
WITH input AS NOT MATERIALIZED (
  SELECT :bootstrap::uuid AS bootstrap, :execution::text AS execution,
         NULLIF(:predecessor::text,'')::uuid AS predecessor
)
SELECT step::text, predecessor::text, state, complete, input_limit, receipt_protocol,
       verified_root, verified_home, encode(repair_locator_digests,'hex') AS repair_locator_digests
FROM (
  SELECT r.*
  FROM input i JOIN semantic.public_filter_repair_step r
    ON (r.partition_no,r.bootstrap,r.execution,r.predecessor) = (0,i.bootstrap,i.execution,i.predecessor)
  UNION ALL
  SELECT r.*
  FROM input i JOIN semantic.public_filter_repair_step r
    ON (r.partition_no,r.bootstrap,r.execution) = (0,i.bootstrap,i.execution)
  WHERE i.predecessor IS NULL AND r.predecessor IS NULL
) AS successor
LIMIT 1;
