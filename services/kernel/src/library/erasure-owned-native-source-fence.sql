-- Final fixed phase, AFTER all source-writer hooks and the fact-source-head barrier.
WITH collection_keys AS MATERIALIZED (
 SELECT kind,owner_id FROM library.native_source_fence
 WHERE route=:route AND account_id=:account_id AND kind='collection'
 ORDER BY kind,owner_id LIMIT 98
), keys AS MATERIALIZED (
 SELECT kind,owner_id FROM collection_keys
 UNION ALL
 SELECT kind,owner_id FROM library.native_source_fence
 WHERE route=:route AND kind='account' AND owner_id=:account_id
)
DELETE FROM library.native_source_fence f USING keys
WHERE f.route=:route AND f.kind=keys.kind AND f.owner_id=keys.owner_id
 AND (f.account_id=:account_id OR (f.kind='account' AND f.owner_id=:account_id))
 AND NOT EXISTS (SELECT 1 FROM library.native_source_capture c WHERE c.route=f.route AND c.account_id=:account_id)
 AND (f.kind='account' OR (
   NOT EXISTS (SELECT 1 FROM library.collection c WHERE c.route=f.route AND c.collection_id=f.owner_id)
   AND NOT EXISTS (SELECT 1 FROM library.native_source_capture c WHERE c.route=f.route AND c.collection_id=f.owner_id)
 ))
 AND NOT EXISTS (SELECT 1 FROM library.collection c WHERE c.route=f.route AND c.curator_account_id=:account_id)
RETURNING true AS removed;
