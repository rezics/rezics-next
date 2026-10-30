SELECT curator_account_id AS "curatorAccountId", visibility, state
FROM library.collection
WHERE route = :route::integer AND collection_id = :collection_id::uuid;
