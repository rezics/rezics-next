SELECT curator_account_id::text AS "accountId", state, visibility,
       source_generation::text AS "sourceGeneration"
FROM library.collection
WHERE route=$1 AND collection_id=$2
FOR UPDATE;
