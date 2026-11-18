/* semantic.native-keyed:2:7 */
WITH input AS NOT MATERIALIZED (
  SELECT :bootstrap::uuid AS bootstrap,:execution::text AS execution,
         NULLIF(:predecessor::text,'')::uuid AS predecessor
), successor AS MATERIALIZED (
  SELECT r.* FROM input i JOIN semantic.public_filter_repair_step r
    ON (r.partition_no,r.bootstrap,r.execution,r.predecessor)=(0,i.bootstrap,i.execution,i.predecessor)
  UNION ALL
  SELECT r.* FROM input i JOIN semantic.public_filter_repair_step r
    ON (r.partition_no,r.bootstrap,r.execution)=(0,i.bootstrap,i.execution)
  WHERE i.predecessor IS NULL AND r.predecessor IS NULL
)
SELECT s.step::text,s.predecessor::text,s.state,s.complete,s.input_limit,s.receipt_protocol,
       s.verified_root,s.verified_home,encode(s.repair_locator_digests,'hex') AS repair_locator_digests,
       p.state AS predecessor_state,p.verified_root AS predecessor_root
FROM successor s LEFT JOIN semantic.public_filter_repair_step p
  ON (p.partition_no,p.bootstrap,p.execution,p.step)=(0,s.bootstrap,s.execution,s.predecessor)
WHERE s.verified_binding=:binding::text AND s.verified_root IS NOT NULL
  AND s.verified_ordinal=coalesce(p.verified_ordinal+1,1)
  AND (s.predecessor IS NULL OR (
    p.verified_next=s.step AND p.verified_binding=s.verified_binding AND p.verified_root IS NOT NULL
    AND p.receipt_protocol=1 AND NOT p.complete
  ))
LIMIT 1;
