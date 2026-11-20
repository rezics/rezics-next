/* semantic.native-keyed:2:7 */
WITH input AS NOT MATERIALIZED (
  SELECT :bootstrap::uuid AS bootstrap,:execution::text AS execution,:binding::text AS binding,
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
       encode(s.repair_locator_digests,'hex') AS repair_locator_digests,
       s.verified_root,
       p.state AS predecessor_state,p.verified_root AS predecessor_root,
       p.complete AS predecessor_complete,p.receipt_protocol AS predecessor_protocol,
       (p.verified_binding=i.binding AND p.verified_root IS NOT NULL
        AND p.verified_ordinal IS NOT NULL) IS TRUE AS predecessor_verified,
       (s.verified_binding=i.binding AND s.verified_root IS NOT NULL
        AND s.verified_ordinal=coalesce(p.verified_ordinal+1,1)
        AND (i.predecessor IS NULL OR (
          p.verified_binding=i.binding AND p.verified_root IS NOT NULL AND p.verified_next=s.step
          AND p.receipt_protocol=1 AND NOT p.complete
        ))) IS TRUE AS linked
FROM input i
LEFT JOIN successor s ON TRUE
LEFT JOIN semantic.public_filter_repair_step p
  ON (p.partition_no,p.bootstrap,p.execution,p.step)=(0,i.bootstrap,i.execution,i.predecessor)
LIMIT 1;
