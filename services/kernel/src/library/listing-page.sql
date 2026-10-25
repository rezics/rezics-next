SELECT collection_id AS "collectionId", collection_route AS "collectionRoute", multiplicity,
       updated_at::text AS "updatedAt", transaction_id AS "transactionId"
FROM library.subject_collection
WHERE route = :route AND subject_id = :subject_id
  AND collection_id > :after::uuid
ORDER BY collection_id
LIMIT :limit;
