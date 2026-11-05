SELECT e.version FROM access.account AS a JOIN access.erasure AS e USING(route,account_id)
 JOIN core.outbox AS o ON o.partition_no=:partition::integer AND o.position=:position::bigint AND o.id=:event_id::uuid
 WHERE a.route=:route::integer AND a.account_id=:account_id::uuid AND a.state='deleted' AND a.authn_fenced
 AND o.epoch=:event_epoch::integer AND o.type='com.rezics.access.account-tombstoned.v1' AND o.subject=a.account_id::text
 AND EXISTS (SELECT 1 FROM access.lifecycle_fence_receipt f WHERE f.route=a.route AND f.account_id=a.account_id
 AND f.receipt_id=(o.data->>'receiptId')::uuid AND f.kind='tombstone'
 AND f.minimum_authn_epoch=(o.data->>'minimumAuthnEpoch')::bigint AND a.minimum_authn_epoch>=f.minimum_authn_epoch)
 AND o.data=:data::jsonb AND o.recorded_at=:time::timestamptz LIMIT 1 FOR SHARE OF a,e;
