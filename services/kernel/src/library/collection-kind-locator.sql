SELECT curator_account_id::text AS "accountId"
FROM library.collection WHERE route=:route::integer AND collection_id=:collection_id::uuid
LIMIT 1;
