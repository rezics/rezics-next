-- One raw account capture locator, never a history or global owner walk.
SELECT capture_id::text AS id, collection_id::text AS "collectionId"
FROM library.native_source_capture WHERE route=:route AND account_id=:account_id
AND (:after_id::nullable(uuid) IS NULL OR capture_id>:after_id)
ORDER BY capture_id LIMIT 1;
