-- Same Source-home locks, including native writer keys. No ordinary ready-reader dependency.
SELECT c.capture_id::text AS capture_id
FROM library.collection s
JOIN access.account a ON a.route=$4 AND a.account_id=$5 AND a.state='active' AND NOT a.authn_fenced
JOIN core.partition p ON p.partition_no=($1 >> 4) AND p.epoch=$6
 AND p.write_state='active' AND p.moved_to IS NULL
JOIN library.native_source_fence cf ON cf.route=s.route AND cf.kind='collection' AND cf.owner_id=s.collection_id
JOIN library.native_source_fence af ON af.route=a.route AND af.kind='account' AND af.owner_id=a.account_id
JOIN library.native_source_capture c ON c.route=s.route AND c.capture_id=$3
JOIN library.native_source_receipt r ON (r.route,r.capture_id)=(c.route,c.capture_id)
 AND r.xmin=c.xmin AND r.owner_epoch=p.epoch AND p.position>=r.position
WHERE s.route=$1 AND s.collection_id=$2 AND s.curator_account_id=a.account_id AND s.state='active'
 AND s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text=$7
 AND s.source_generation=$8 AND c.collection_id=s.collection_id AND c.account_id=a.account_id
 AND c.incarnation=$7 AND c.generation=$8 AND c.scope=$9 AND c.owner_epoch=$6
 AND c.receiving_epoch=$10 AND c.effect_key=$11
 AND cf.generation=$12 AND af.generation=$13 AND c.collection_fence=cf.generation AND c.account_fence=af.generation
 AND c.complete AND c.driver='done' AND c.version=$14 AND c.scanned=$15
 AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
 AND (($9='curated' AND s.membership_kind='curated')
   OR ($9='private_builtin' AND s.membership_kind='dynamic')
   OR ($9='active_explicit_output' AND s.membership_kind='dynamic' AND s.visibility<>'private'))
FOR SHARE OF s,a,p,cf,af,c,r;
