SELECT c.capture_id::text AS "captureId", c.collection_fence::text AS "collectionFence",
 c.account_fence::text AS "accountFence", c.complete,
 c.driver,c.after_key AS after,c.tie,c.session_id::text AS "sessionId",c.scanned::text,c.version
FROM library.native_source_capture c
WHERE c.route=:route AND c.collection_id=:collection_id AND c.account_id=:account_id
 AND c.incarnation=:incarnation AND c.generation=:generation AND c.scope=:scope
 AND c.owner_epoch=:owner_epoch AND c.receiving_epoch=:receiving_epoch AND c.effect_key=:effect_key
 AND c.collection_fence=:collection_fence AND c.account_fence=:account_fence
 AND c.capture_id=coalesce(:capture_id::uuid,c.capture_id)
ORDER BY c.capture_id LIMIT 1 FOR SHARE;
