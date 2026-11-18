-- Same Source-home locks, including native writer keys. No ordinary ready-reader dependency.
WITH input AS NOT MATERIALIZED (
 SELECT $1::integer AS route,
        $2::uuid AS collection_id,
        $3::uuid AS capture_id,
        $4::integer AS account_route,
        $5::uuid AS account_id,
        $6::integer AS owner_epoch,
        $7::text AS incarnation,
        $8::bigint AS generation,
        $9::text AS scope,
        $10::bigint AS receiving_epoch,
        $11::text AS effect_key,
        $12::bigint AS collection_fence,
        $13::bigint AS account_fence,
        $14::integer AS version,
        $15::bigint AS scanned
), stored AS MATERIALIZED (
 SELECT s.route,s.collection_id FROM input i JOIN library.collection s
   ON s.route=i.route AND s.collection_id=i.collection_id
 WHERE s.curator_account_id=i.account_id AND s.state='active'
   AND s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text=i.incarnation
   AND s.source_generation=i.generation
   AND ((i.scope='curated' AND s.membership_kind='curated')
     OR (i.scope='private_builtin' AND s.membership_kind='dynamic')
     OR (i.scope='active_explicit_output' AND s.membership_kind='dynamic' AND s.visibility<>'private'))
 FOR SHARE OF s
), logical AS MATERIALIZED (
 SELECT s.route,s.collection_id FROM input i JOIN library.logical_everything_source s
   ON s.route=i.route AND s.collection_id=i.collection_id AND s.account_id=i.account_id
 WHERE i.scope='private_builtin' AND s.incarnation=i.incarnation AND s.generation=i.generation
 FOR SHARE OF s
), source AS (
 SELECT * FROM stored UNION ALL SELECT * FROM logical
)
SELECT c.capture_id::text AS capture_id
FROM input i JOIN source s ON s.route=i.route AND s.collection_id=i.collection_id
JOIN access.account a ON a.route=i.account_route AND a.account_id=i.account_id AND a.state='active' AND NOT a.authn_fenced
JOIN core.partition p ON p.partition_no=(i.route >> 4) AND p.epoch=i.owner_epoch
 AND p.write_state='active' AND p.moved_to IS NULL
JOIN library.native_source_fence cf ON cf.route=s.route AND cf.kind='collection' AND cf.owner_id=s.collection_id
JOIN library.native_source_fence af ON af.route=a.route AND af.kind='account' AND af.owner_id=a.account_id
JOIN library.native_source_capture c ON c.route=s.route AND c.capture_id=i.capture_id
JOIN library.native_source_receipt r ON (r.route,r.capture_id)=(c.route,c.capture_id)
 AND r.xmin=c.xmin AND r.owner_epoch=p.epoch AND p.position>=r.position
WHERE c.collection_id=s.collection_id AND c.account_id=a.account_id
 AND c.incarnation=i.incarnation AND c.generation=i.generation AND c.scope=i.scope AND c.owner_epoch=i.owner_epoch
 AND c.receiving_epoch=i.receiving_epoch AND c.effect_key=i.effect_key
 AND cf.generation=i.collection_fence AND af.generation=i.account_fence AND c.collection_fence=cf.generation AND c.account_fence=af.generation
 AND c.complete AND c.driver='done' AND c.version=i.version AND c.scanned=i.scanned
 AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
FOR SHARE OF a,p,cf,af,c,r;
