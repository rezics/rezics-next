-- The owning command holds this head through child deletion/commit. No retained payload is projected.
SELECT curator_account_id::text AS "accountId", revision, deletion_id::text AS "deletionId",
       source_generation::text AS "sourceGeneration", state,
       purge_after = :purge_after::nullable(timestamptz) AS "deadlineMatches",
       deleted_at IS NOT NULL AND purge_after = deleted_at + interval '720 hours'
         AND purge_after <= :time::timestamptz AS due,
       EXISTS (
         SELECT 1 FROM library.native_source_capture AS capture
         WHERE capture.route = collection.route AND capture.collection_id = collection.collection_id
       ) AS "sourceCustody",
       EXISTS (SELECT 1 FROM library.collection_source_output o
         WHERE o.route=collection.route AND o.collection_id=collection.collection_id)
       OR visibility = 'public' OR listing_ever_public OR EXISTS (
         SELECT 1 FROM library.collection_listing_history AS history
         WHERE history.route = collection.route AND history.collection_id = collection.collection_id
       ) AS "publicCustody"
FROM library.collection
WHERE route = :route::integer AND collection_id = :collection_id::uuid
FOR UPDATE;
