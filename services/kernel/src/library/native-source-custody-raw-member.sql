SELECT ordinal_key AS key,member_id::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.collection_member WHERE route=:route AND collection_id=:collection_id
AND (ordinal_key,member_id) > (:after::text COLLATE "C",:tie::uuid)
ORDER BY ordinal_key,member_id LIMIT :limit;
